"use strict";

const STORAGE_KEY = "monetaTribeData";

// Pages and elements use the IDs from index.html.
const pageIds = ["sessionLoadingPage", "loginPage", "createAccountPage", "resetPasswordPage", "homePage", "profilePage", "setupPage", "editEnvelopePage", "addEnvelopePage", "transactionPage", "historyPage", "transferPage"];
const $ = id => document.getElementById(id);

const supabaseClient = window.supabase.createClient(
    window.MONETATRIBE_SUPABASE_URL,
    window.MONETATRIBE_SUPABASE_PUBLISHABLE_KEY
);
let activeUser = null;
let activeFamily = null;
let activeFamilyRole = null;
let activeFamilyRestricted = false;
let budgetProfileMode = "personal";
let familySchemaAvailable = true;
let passwordRecoveryActive = window.location.hash.includes("type=recovery");
let cloudBudgetId = null;
let cloudSaveTimer = null;
let cloudSaveInFlight = Promise.resolve();
const budgetProfileCache = new Map();
const familyMembersCache = new Map();
const familyMembersLoading = new Set();
const familyMembersPromises = new Map();
let familyMembershipLoadedUserId = null;
const budgetProfileCacheTtlMs = 30000;
let isDemoBudget = false;
let budgetStartDate = "";
let budgetEndDate = "";
let budgetCycleMode = "30days";
let previousEnvelopeBudgets = {};
let historyViewingArchive = false;
let historyPocketFilter = null;
let archivedTransactions = [];
let archivedBudgetIds = [];
let archiveManageMode = false;
let budgetRolloverTimer = null;
function localDateISO(date = new Date()) {
    return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
}
function addDaysToISO(isoDate, days) {
    const date = new Date(`${isoDate}T00:00:00Z`);
    date.setUTCDate(date.getUTCDate() + days);
    return date.toISOString().slice(0, 10);
}
function endOfMonthISO(isoDate) {
    const date = new Date(`${isoDate}T00:00:00Z`);
    return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + 1, 0)).toISOString().slice(0, 10);
}
function isFamilySchemaMissingError(error) {
    return error?.code === "PGRST205" || error?.code === "PGRST204" || /family_members.*schema cache|could not find the table ['"]?public\.family_members|column .*is_restricted.*schema cache/i.test(error?.message || "");
}
function familySetupRequiredMessage() {
    return "Family features are not fully enabled yet. Run supabase-family-migration.sql and the latest supabase-family-members-migration.sql in the Supabase Dashboard SQL Editor, then reload the app.";
}
function familyMembersSetupRequiredMessage() {
    return "Family member listing, restrictions, and Exit Family need setup. Run the latest supabase-family-members-migration.sql in the Supabase Dashboard SQL Editor, then reload the app.";
}
function deleteFamilySetupRequiredMessage() {
    return "Delete Family is not installed in Supabase yet. Run supabase-delete-family-migration.sql in the Supabase Dashboard SQL Editor, then reload the app.";
}
function nextBudgetPeriod(previousEndDate, mode = budgetCycleMode, today = localDateISO()) {
    let startDate = addDaysToISO(previousEndDate, 1);
    if (mode === "monthEnd") {
        let endDate = endOfMonthISO(startDate);
        while (endDate < today) {
            startDate = addDaysToISO(endDate, 1);
            endDate = endOfMonthISO(startDate);
        }
        return { startDate, endDate };
    }
    let endDate = addDaysToISO(startDate, 29);
    while (endDate < today) {
        startDate = addDaysToISO(startDate, 30);
        endDate = addDaysToISO(startDate, 29);
    }
    return { startDate, endDate };
}
function loadBudgetCycleMode() {
    if (!activeUser) return;
    const saved = localStorage.getItem(`monetaTribeCycleMode_${activeUser.id}`);
    const cloudMode = activeUser.user_metadata?.monetatribe_budget_cycle_mode;
    const mode = cloudMode || saved;
    budgetCycleMode = mode === "monthEnd" ? "monthEnd" : "30days";
}
function initializeBudgetDates(startDate = localDateISO(), duration = 30) {
    budgetStartDate = startDate;
    budgetEndDate = addDaysToISO(startDate, duration - 1);
}
async function rollOverBudget() {
    if (budgetProfileMode === "family" && !isActiveFamilyAdmin()) return false;
    if (!activeUser || !budgetEndDate || localDateISO() <= budgetEndDate) return false;
    const nextPeriod = nextBudgetPeriod(budgetEndDate);
    const lastEnvelopeBudgets = Object.fromEntries(envelopes.map(envelope => [envelope.name, envelope.budget]));
    const { data: nextBudget, error } = await supabaseClient.from("monthly_budgets")
        .insert({ user_id: activeUser.id, ...(familySchemaAvailable ? { family_id: budgetProfileMode === "family" ? activeFamily?.id : null } : {}), monthly_income: 0, start_date: nextPeriod.startDate, end_date: nextPeriod.endDate })
        .select("id").single();
    if (error) throw error;
    budgetStartDate = nextPeriod.startDate;
    budgetEndDate = nextPeriod.endDate;
    previousEnvelopeBudgets = lastEnvelopeBudgets;
    monthlyIncome = 0;
    envelopes = envelopes.map(envelope => ({ ...envelope, budget: 0, spent: 0 }));
    cloudBudgetId = nextBudget.id;
    transactions = [];
    await saveCloudData();
    refreshAll();
    return true;
}
function scheduleBudgetRollover() {
    clearTimeout(budgetRolloverTimer);
    if (!activeUser || !budgetEndDate || (budgetProfileMode === "family" && !isActiveFamilyAdmin())) return;
    const nextCycleStart = new Date(`${budgetEndDate}T23:59:59`);
    const delay = Math.max(0, nextCycleStart.getTime() + 1000 - Date.now());
    budgetRolloverTimer = setTimeout(() => {
        rollOverBudget().then(scheduleBudgetRollover).catch(error => {
            console.error("Automatic budget rollover failed:", error);
            alert("The new budget period could not be started. Please check your connection and try again.");
        });
    }, Math.min(delay, 2147483000));
}
const defaultEnvelopes = [
    { name: "Groceries", budget: 8000, spent: 3500 },
    { name: "Fuel", budget: 4000, spent: 2400 },
    { name: "Household", budget: 3000, spent: 1800 },
    { name: "Entertainment", budget: 2000, spent: 500 }
];

const pocketIconDefinitions = {
    groceries: { label: "Groceries", svg: '<circle cx="9" cy="20" r="1"/><circle cx="18" cy="20" r="1"/><path d="M3 4h2l2.2 11h11.2L21 8H6"/><path d="M10 8v5m4-5v5"/>' },
    housing: { label: "Home", svg: '<path d="m3 10 9-7 9 7"/><path d="M5 9v12h14V9M9 21v-7h6v7"/>' },
    transport: { label: "Transport", svg: '<path d="m5 11 1.4-4.2A2 2 0 0 1 8.3 5h7.4a2 2 0 0 1 1.9 1.8L19 11"/><path d="M4 11h16v7H4zM7 18v2m10-2v2M7 14h.01M17 14h.01"/>' },
    dining: { label: "Dining", svg: '<path d="M7 3v7m-3-7v4a3 3 0 0 0 6 0V3m-3 7v11"/><path d="M17 3v18m0-18c3 2 3 7 0 9"/>' },
    health: { label: "Health", svg: '<path d="M12 21s-8-4.8-8-11a4.5 4.5 0 0 1 8-2.8A4.5 4.5 0 0 1 20 10c0 6.2-8 11-8 11Z"/><path d="M9 12h6m-3-3v6"/>' },
    utilities: { label: "Utilities", svg: '<path d="m13 2-9 12h7l-1 8 10-13h-7l1-7Z"/>' },
    education: { label: "Education", svg: '<path d="M3 5.5A2.5 2.5 0 0 1 5.5 3H12v17H5.5A2.5 2.5 0 0 0 3 22V5.5Zm18 0A2.5 2.5 0 0 0 18.5 3H12v17h6.5a2.5 2.5 0 0 1 2.5 2V5.5Z"/>' },
    shopping: { label: "Shopping", svg: '<path d="M5 8h14l1 13H4L5 8Z"/><path d="M9 9V6a3 3 0 0 1 6 0v3"/>' },
    entertainment: { label: "Fun", svg: '<path d="M4 5h16v14H4z"/><path d="m9 5-2 14m10-14 2 14M4 9h3m10 0h3M4 15h3m10 0h3"/>' },
    travel: { label: "Travel", svg: '<rect x="3" y="7" width="18" height="14" rx="2"/><path d="M8 7V5a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2M3 12h18m-11 0v2h4v-2"/>' },
    savings: { label: "Savings", svg: '<path d="M5 11a7 7 0 0 1 12-3h3v5h-2a7 7 0 0 1-7 6H8l-3 2v-4a7 7 0 0 1 0-6Z"/><circle cx="13" cy="11" r="1"/><path d="M7 8 5 6M8 18l-1 2"/>' },
    personal: { label: "Personal care", svg: '<path d="m12 2 1.7 6.3L20 10l-6.3 1.7L12 18l-1.7-6.3L4 10l6.3-1.7L12 2Z"/><path d="m19 16 .8 2.2L22 19l-2.2.8L19 22l-.8-2.2L16 19l2.2-.8L19 16Z"/>' },
    pets: { label: "Pets", svg: '<circle cx="6.5" cy="8" r="2"/><circle cx="11" cy="5.5" r="2"/><circle cx="16" cy="6" r="2"/><circle cx="19" cy="10" r="2"/><path d="M12 11c-3.8 0-7 5-4.5 7.5 1.5 1.5 3-.5 4.5-.5s3 2 4.5.5C19 16 15.8 11 12 11Z"/>' },
    gifts: { label: "Gifts", svg: '<path d="M3 10h18v11H3zM2 7h20v4H2zM12 7v14"/><path d="M12 7H8.5a2.5 2.5 0 1 1 2.3-3.5L12 7Zm0 0h3.5a2.5 2.5 0 1 0-2.3-3.5L12 7Z"/>' },
    general: { label: "General", svg: '<rect x="3" y="3" width="7" height="7" rx="1.5"/><rect x="14" y="3" width="7" height="7" rx="1.5"/><rect x="3" y="14" width="7" height="7" rx="1.5"/><rect x="14" y="14" width="7" height="7" rx="1.5"/>' }
};

function inferPocketIconKey(name) {
    const value = String(name || "").toLowerCase();
    if (/grocer|food/.test(value)) return "groceries";
    if (/rent|housing|home|house|mortgage|household/.test(value)) return "housing";
    if (/fuel|transport|car|bus|commute/.test(value)) return "transport";
    if (/dining|restaurant|cafe|take.?out/.test(value)) return "dining";
    if (/health|medical|doctor|medicine|pharmacy/.test(value)) return "health";
    if (/utilit|electric|water|internet|phone|bill/.test(value)) return "utilities";
    if (/school|education|tuition|course/.test(value)) return "education";
    if (/shopping|clothing|clothes/.test(value)) return "shopping";
    if (/entertain|movie|game|hobby/.test(value)) return "entertainment";
    if (/travel|trip|vacation/.test(value)) return "travel";
    if (/saving|investment|emergency/.test(value)) return "savings";
    if (/personal|care|beauty/.test(value)) return "personal";
    if (/pet/.test(value)) return "pets";
    if (/gift|donation/.test(value)) return "gifts";
    return "general";
}
function normalizePocketIconKey(key, name) {
    return Object.prototype.hasOwnProperty.call(pocketIconDefinitions, key) ? key : inferPocketIconKey(name);
}
function pocketIconMarkup(key) {
    const icon = pocketIconDefinitions[normalizePocketIconKey(key)];
    return '<svg viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round">' + icon.svg + "</svg>";
}
function renderPocketIconPicker(containerId, inputId, selectedKey) {
    const container = $(containerId);
    const input = $(inputId);
    if (!container || !input) return;
    container.replaceChildren();
    input.value = normalizePocketIconKey(selectedKey);
    const dropdown = container.closest(".pocket-icon-dropdown");
    const preview = $(container.dataset.previewId);
    const selectedName = $(container.dataset.labelId);
    const updateSelection = key => {
        input.value = key;
        if (preview) preview.innerHTML = pocketIconMarkup(key);
        if (selectedName) selectedName.textContent = pocketIconDefinitions[key].label;
        container.querySelectorAll(".pocket-icon-option").forEach(option => {
            option.setAttribute("aria-checked", String(option.dataset.iconKey === key));
        });
    };
    Object.entries(pocketIconDefinitions).forEach(([key, icon]) => {
        const button = document.createElement("button");
        button.type = "button";
        button.className = "pocket-icon-option";
        button.dataset.iconKey = key;
        button.setAttribute("role", "radio");
        button.setAttribute("aria-checked", String(key === input.value));
        button.setAttribute("aria-label", icon.label);
        button.title = icon.label;
        button.innerHTML = pocketIconMarkup(key) + "<span>" + icon.label + "</span>";
        button.addEventListener("click", () => {
            updateSelection(key);
            if (dropdown) {
                dropdown.open = false;
                dropdown.querySelector("summary")?.focus();
            }
        });
        container.appendChild(button);
    });
    updateSelection(input.value);
}

document.addEventListener("click", event => {
    document.querySelectorAll(".pocket-icon-dropdown[open]").forEach(dropdown => {
        if (!dropdown.contains(event.target)) dropdown.open = false;
    });
});

let envelopes = defaultEnvelopes.map(e => ({ ...e }));
let transactions = [];
let monthlyIncome = 40000;
let historyManageMode = false;
let currentVisiblePageId = null;
let initialPageResolved = false;

function loadAppData() {
    try {
        const raw = localStorage.getItem(STORAGE_KEY);
        if (!raw) return;
        const data = JSON.parse(raw);
        if (Array.isArray(data.envelopes)) envelopes = data.envelopes;
        if (Array.isArray(data.transactions)) transactions = data.transactions;
        if (Number.isFinite(data.monthlyIncome)) monthlyIncome = data.monthlyIncome;
        if (data.budgetCycleMode === "30days" || data.budgetCycleMode === "monthEnd") budgetCycleMode = data.budgetCycleMode;
        if (typeof data.budgetStartDate === "string" && typeof data.budgetEndDate === "string") {
            budgetStartDate = data.budgetStartDate;
            budgetEndDate = data.budgetEndDate;
        } else {
            const legacyDuration = Number.isInteger(data.budgetDurationDays) && data.budgetDurationDays >= 1 && data.budgetDurationDays <= 365 ? data.budgetDurationDays : 30;
            initializeBudgetDates(localDateISO(), legacyDuration);
        }
        envelopes = envelopes.filter(e => e && typeof e.name === "string")
            .map(e => ({ name: e.name, budget: Number(e.budget) || 0, spent: Number(e.spent) || 0, iconKey: normalizePocketIconKey(e.iconKey, e.name) }));
        transactions = transactions.filter(t => t && typeof t === "object");
    } catch (error) {
        console.error("Unable to load saved Moneta Tribe data:", error);
    }
}

function saveAppData() {
    rememberCurrentBudgetProfile();
    try {
        localStorage.setItem(STORAGE_KEY, JSON.stringify({ envelopes, transactions, monthlyIncome, budgetStartDate, budgetEndDate, budgetCycleMode }));
    } catch (error) {
        console.error("Unable to save MonetaTribe data locally:", error);
    }
    if (activeUser) {
        clearTimeout(cloudSaveTimer);
        cloudSaveTimer = setTimeout(() => {
            cloudSaveTimer = null;
            saveCloudData().catch(error => {
            console.error("Supabase save failed:", error);
            alert(`Cloud save failed: ${error.message || "Unknown Supabase error"}. Check the Supabase table policies and try again.`);
            });
        }, 700);
    }
}

function currentBudgetProfileCacheKey() {
    if (!activeUser) return null;
    return budgetProfileMode === "family" && activeFamily
        ? `${activeUser.id}:family:${activeFamily.id}`
        : `${activeUser.id}:personal`;
}

function setBudgetProfilePreference(mode, userId = activeUser?.id) {
    budgetProfileMode = mode === "family" ? "family" : "personal";
    if (userId) localStorage.setItem(`monetaTribeBudgetProfile_${userId}`, budgetProfileMode);
}

async function syncBudgetProfilePreference(mode = budgetProfileMode) {
    if (!activeUser) return;
    const normalizedMode = mode === "family" ? "family" : "personal";
    const metadata = { ...(activeUser.user_metadata || {}), monetatribe_default_budget_profile: normalizedMode };
    const { data, error } = await supabaseClient.auth.updateUser({ data: metadata });
    if (error) throw error;
    if (data?.user) activeUser = data.user;
    setBudgetProfilePreference(normalizedMode);
}

function isActiveFamilyAdmin() {
    return Boolean(activeFamily && activeUser && (activeFamilyRole === "admin" || activeFamily.created_by === activeUser.id));
}

function isRestrictedFamilyMember() {
    return Boolean(budgetProfileMode === "family" && activeFamily && !isActiveFamilyAdmin() && activeFamilyRestricted);
}

function familyAdminOnlyMessage() {
    return "Only the Family Admin can change pockets, budgets, transfers, or transactions.";
}

function rememberCurrentBudgetProfile() {
    const key = currentBudgetProfileCacheKey();
    if (!key) return;
    budgetProfileCache.set(key, {
        savedAt: Date.now(), cloudBudgetId, monthlyIncome, budgetStartDate, budgetEndDate,
        budgetCycleMode, previousEnvelopeBudgets: { ...previousEnvelopeBudgets }, isDemoBudget,
        envelopes: envelopes.map(envelope => ({ ...envelope })),
        transactions: transactions.map(transaction => ({ ...transaction }))
    });
}

function restoreCachedBudgetProfile(cached) {
    cloudBudgetId = cached.cloudBudgetId;
    monthlyIncome = cached.monthlyIncome;
    budgetStartDate = cached.budgetStartDate;
    budgetEndDate = cached.budgetEndDate;
    budgetCycleMode = cached.budgetCycleMode;
    previousEnvelopeBudgets = { ...cached.previousEnvelopeBudgets };
    isDemoBudget = cached.isDemoBudget;
    envelopes = cached.envelopes.map(envelope => ({ ...envelope }));
    transactions = cached.transactions.map(transaction => ({ ...transaction }));
}

async function loadCloudData(preferredMode = null) {
    if (!activeUser) return;
    loadBudgetCycleMode();
    const accountMode = activeUser.user_metadata?.monetatribe_default_budget_profile;
    const localMode = localStorage.getItem(`monetaTribeBudgetProfile_${activeUser.id}`);
    const savedMode = preferredMode === "family" || preferredMode === "personal"
        ? preferredMode
        : accountMode === "family" || accountMode === "personal" ? accountMode : localMode;
    setBudgetProfilePreference(savedMode === "family" ? "family" : "personal");
    if (familyMembershipLoadedUserId !== activeUser.id) {
        const { data: memberships, error: membershipError } = await supabaseClient.from("family_members")
            .select("family_id,role,is_restricted,families(id,name,invite_code,created_by)").eq("user_id", activeUser.id).limit(1);
        familySchemaAvailable = !membershipError;
        if (membershipError && !isFamilySchemaMissingError(membershipError)) throw membershipError;
        if (!familySchemaAvailable) {
            activeFamily = null;
            activeFamilyRole = null;
            activeFamilyRestricted = false;
            setBudgetProfilePreference("personal");
        } else {
            const familyRelation = memberships?.[0]?.families;
            activeFamily = Array.isArray(familyRelation) ? (familyRelation[0] || null) : (familyRelation || null);
            activeFamilyRole = activeFamily && (activeFamily.created_by === activeUser.id || memberships?.[0]?.role === "admin")
                ? "admin" : (activeFamily ? "member" : null);
            activeFamilyRestricted = Boolean(activeFamily && memberships?.[0]?.is_restricted);
        }
        familyMembershipLoadedUserId = activeUser.id;
    }
    if (!activeFamily) {
        activeFamilyRole = null;
        activeFamilyRestricted = false;
        setBudgetProfilePreference("personal");
    }
    if (accountMode !== budgetProfileMode) {
        try { await syncBudgetProfilePreference(); }
        catch (error) { console.warn("Could not sync the default budget profile to the account:", error); }
    }
    const cacheKey = currentBudgetProfileCacheKey();
    const cachedProfile = cacheKey ? budgetProfileCache.get(cacheKey) : null;
    const cachedProfileIsEmptyButSaved = Boolean(cachedProfile?.cloudBudgetId && cachedProfile.envelopes.length === 0);
    if (cachedProfile && !cachedProfileIsEmptyButSaved && Date.now() - cachedProfile.savedAt < budgetProfileCacheTtlMs) {
        restoreCachedBudgetProfile(cachedProfile);
        refreshAll({ persist: false });
        scheduleBudgetRollover();
        return;
    }
    let budgetQuery = supabaseClient.from("monthly_budgets").select("*");
    budgetQuery = budgetProfileMode === "family" && activeFamily
        ? budgetQuery.eq("family_id", activeFamily.id)
        : familySchemaAvailable
            ? budgetQuery.eq("user_id", activeUser.id).is("family_id", null)
            : budgetQuery.eq("user_id", activeUser.id);
    const { data: budget, error: budgetError } = await budgetQuery
        .order("start_date", { ascending: false }).limit(1).maybeSingle();
    if (budgetError) throw budgetError;
    cloudBudgetId = budget?.id || null;
    if (!budget) {
        if (isRestrictedFamilyMember()) {
            initializeBudgetDates();
            envelopes = [];
            transactions = [];
            monthlyIncome = 0;
            isDemoBudget = false;
            refreshAll({ persist: false });
            setText("familyProfileStatus", "The Family Admin needs to set up the shared budget before transactions can be added.");
            scheduleBudgetRollover();
            return;
        }
        initializeBudgetDates();
        previousEnvelopeBudgets = {};
        const demoKey = `monetaTribeDemoShown_${activeUser.id}`;
        const demoAlreadyShown = localStorage.getItem(demoKey) === "yes";
        if (!demoAlreadyShown) {
            // First-time account: load editable examples, with no fictitious transactions.
            monthlyIncome = 50000;
            envelopes = [
                { name: "Groceries", budget: 10000, spent: 0 },
                { name: "Housing & Bills", budget: 12000, spent: 0 },
                { name: "Fuel & Transport", budget: 5000, spent: 0 },
                { name: "Household", budget: 4000, spent: 0 },
                { name: "Education", budget: 5000, spent: 0 },
                { name: "Healthcare", budget: 3000, spent: 0 },
                { name: "Entertainment", budget: 3000, spent: 0 }
            ];
            transactions = [];
            isDemoBudget = true;
            localStorage.setItem(demoKey, "yes");
            refreshAll({ persist: false });
        } else {
            envelopes = []; transactions = []; monthlyIncome = 0; isDemoBudget = false;
            refreshAll({ persist: false });
        }
        await saveCloudData();
        scheduleBudgetRollover();
        return;
    }
    isDemoBudget = false;
    monthlyIncome = Number(budget.monthly_income) || 0;
    budgetStartDate = budget.start_date;
    budgetEndDate = budget.end_date;
    const [envelopeResult, transactionResult] = await Promise.all([
        supabaseClient.from("envelopes").select("*").eq("budget_id", budget.id).order("created_at"),
        supabaseClient.from("transactions").select("*").eq("budget_id", budget.id).order("transaction_date", { ascending: false })
    ]);
    const { data: dbEnvelopes, error: envError } = envelopeResult;
    const { data: dbTransactions, error: txError } = transactionResult;
    if (envError) throw envError;
    if (txError) throw txError;
    const byId = new Map((dbEnvelopes || []).map(e => [e.id, e]));
    transactions = (dbTransactions || []).map(t => ({
        id: t.id, userId: t.user_id, type: t.transaction_type, date: t.transaction_date, amount: Number(t.amount), description: t.description || "",
        envelope: byId.get(t.envelope_id)?.name || "", source: t.transaction_type === "transfer" ? byId.get(t.envelope_id)?.name : undefined,
        destination: t.transfer_to_envelope_id ? byId.get(t.transfer_to_envelope_id)?.name : undefined
    }));
    envelopes = (dbEnvelopes || []).map(e => ({ dbId: e.id, name: e.name, budget: Number(e.allocated_budget) || 0, spent: 0, iconKey: normalizePocketIconKey(e.icon_key, e.name) }));
    transactions.filter(t => t.type === "expense").forEach(t => { const e = envelopes.find(item => item.name === t.envelope); if (e) e.spent += t.amount; });
    let previousQuery = supabaseClient.from("monthly_budgets").select("id")
        .neq("id", cloudBudgetId).lt("end_date", localDateISO());
    previousQuery = budgetProfileMode === "family" && activeFamily
        ? previousQuery.eq("family_id", activeFamily.id)
        : familySchemaAvailable
            ? previousQuery.eq("user_id", activeUser.id).is("family_id", null)
            : previousQuery.eq("user_id", activeUser.id);
    const { data: previousBudget, error: previousBudgetError } = await previousQuery
        .order("end_date", { ascending: false }).limit(1).maybeSingle();
    if (previousBudgetError) throw previousBudgetError;
    previousEnvelopeBudgets = {};
    if (previousBudget) {
        const { data: previousEnvelopes, error: previousEnvelopeError } = await supabaseClient.from("envelopes")
            .select("name,allocated_budget").eq("budget_id", previousBudget.id);
        if (previousEnvelopeError) throw previousEnvelopeError;
        previousEnvelopeBudgets = Object.fromEntries((previousEnvelopes || []).map(e => [e.name, Number(e.allocated_budget) || 0]));
    }
    await rollOverBudget();
    refreshAll({ persist: false });
    rememberCurrentBudgetProfile();
    scheduleBudgetRollover();
}

function saveCloudData() {
    if (isRestrictedFamilyMember()) return Promise.resolve();
    const pendingSave = cloudSaveInFlight.catch(() => {}).then(() => persistCloudDataSnapshot());
    cloudSaveInFlight = pendingSave;
    return pendingSave;
}

async function flushPendingCloudSave() {
    const hasScheduledSave = cloudSaveTimer !== null;
    clearTimeout(cloudSaveTimer);
    cloudSaveTimer = null;
    await cloudSaveInFlight;
    if (hasScheduledSave) await saveCloudData();
}

async function persistCloudDataSnapshot() {
    if (!activeUser || isRestrictedFamilyMember()) return;
    const saveUserId = activeUser.id;
    const saveProfileMode = budgetProfileMode;
    const saveFamilyId = activeFamily?.id || null;
    const saveBudgetId = cloudBudgetId;
    const saveFamilySchemaAvailable = familySchemaAvailable;
    const saveIncome = monthlyIncome;
    const saveStartDate = budgetStartDate;
    const saveEndDate = budgetEndDate;
    const saveEnvelopes = envelopes.map(envelope => ({ ...envelope }));
    const saveTransactions = transactions.map(transaction => ({ ...transaction }));
    const iconColumnCheck = await supabaseClient.from("envelopes").select("icon_key").limit(0);
    if (iconColumnCheck.error) {
        const error = iconColumnCheck.error;
        if (error.code === "PGRST204" || error.code === "42703" || /icon_key.*(column|schema cache)/i.test(error.message || "")) {
            throw new Error("Pocket icon sync needs a one-time database update. Run supabase-pocket-icons-migration.sql in the Supabase SQL Editor, then reload the app.");
        }
        throw error;
    }
    if (saveBudgetId && !saveEnvelopes.length) return;
    let budget;
    let budgetError;
    if (saveBudgetId) {
        const result = await supabaseClient.from("monthly_budgets")
            .update({ monthly_income: saveIncome, start_date: saveStartDate, end_date: saveEndDate }).eq("id", saveBudgetId).select("id").single();
        budget = result.data;
        budgetError = result.error;
    } else {
        if (!saveStartDate || !saveEndDate) initializeBudgetDates();
        const result = await supabaseClient.from("monthly_budgets")
            .insert({ user_id: saveUserId, ...(saveFamilySchemaAvailable ? { family_id: saveProfileMode === "family" ? saveFamilyId : null } : {}), monthly_income: saveIncome, start_date: budgetStartDate, end_date: budgetEndDate })
            .select("id").single();
        budget = result.data;
        budgetError = result.error;
    }
    if (budgetError) throw budgetError;
    cloudBudgetId = budget.id;
    // Empty local state can occur during profile loading; never let it erase a saved budget.
    if (!saveEnvelopes.length) {
        rememberCurrentBudgetProfile();
        return;
    }
    // Replace the saved rows as one logical snapshot under this account's persistent budget.
    const { error: deleteTxError } = await supabaseClient.from("transactions").delete().eq("budget_id", cloudBudgetId);
    if (deleteTxError) throw deleteTxError;
    const { error: deleteEnvError } = await supabaseClient.from("envelopes").delete().eq("budget_id", cloudBudgetId);
    if (deleteEnvError) throw deleteEnvError;
    const rows = saveEnvelopes.map(e => ({ user_id: saveUserId, budget_id: budget.id, name: e.name, allocated_budget: e.budget, icon_key: normalizePocketIconKey(e.iconKey, e.name) }));
    const { data: savedEnvelopes, error: insertEnvError } = await supabaseClient.from("envelopes").insert(rows).select("id,name");
    if (insertEnvError) throw insertEnvError;
    const ids = new Map(savedEnvelopes.map(e => [e.name, e.id]));
    envelopes.forEach(envelope => { envelope.dbId = ids.get(envelope.name); });
    const txRows = saveTransactions.map(t => {
        const transfer = t.type === "transfer";
        const sourceName = transfer ? t.source : t.envelope;
        return { user_id: t.userId || saveUserId, budget_id: budget.id, envelope_id: ids.get(sourceName),
            transfer_to_envelope_id: transfer ? ids.get(t.destination) : null, transaction_type: transfer ? "transfer" : "expense",
            transaction_date: t.date, description: t.description || "", amount: t.amount };
    }).filter(t => t.envelope_id);
    if (txRows.length) { const { error } = await supabaseClient.from("transactions").insert(txRows); if (error) throw error; }
    rememberCurrentBudgetProfile();
}
loadAppData();

function money(value) {
    const currency = getCurrency();
    const locale = currency === "USD" ? "en-US" : "en-IN";
    return new Intl.NumberFormat(locale, { style: "currency", currency, maximumFractionDigits: 0 }).format(Number(value) || 0);
}
function getCurrency() {
    return String(activeUser?.user_metadata?.monetatribe_currency || "INR").toUpperCase() === "USD" ? "USD" : "INR";
}
function currencyLabel(currency = getCurrency()) {
    return currency === "USD" ? "USD ($)" : "INR (₹)";
}
function formatAppDate(value) {
    if (!value) return "";
    let year;
    let month;
    let day;
    if (value instanceof Date) {
        if (Number.isNaN(value.getTime())) return "";
        year = value.getFullYear();
        month = value.getMonth() + 1;
        day = value.getDate();
    } else {
        const match = String(value).match(/^(\d{4})-(\d{2})-(\d{2})/);
        if (match) [, year, month, day] = match;
        else {
            const parsed = new Date(value);
            if (Number.isNaN(parsed.getTime())) return String(value);
            year = parsed.getFullYear();
            month = parsed.getMonth() + 1;
            day = parsed.getDate();
        }
    }
    const dd = String(day).padStart(2, "0");
    const mm = String(month).padStart(2, "0");
    const yyyy = String(year).padStart(4, "0");
    return (getCurrency() === "USD" ? [mm, dd, yyyy] : [dd, mm, yyyy]).join("-");
}
function updateCurrencySymbols() {
    const symbol = getCurrency() === "USD" ? "$" : "₹";
    document.querySelectorAll(".currency-symbol").forEach(element => { element.textContent = symbol; });
}
function totalBudget() { return envelopes.reduce((sum, e) => sum + e.budget, 0); }
function totalSpent() { return envelopes.reduce((sum, e) => sum + e.spent, 0); }
function availableIncome() { return monthlyIncome - totalBudget(); }
function actualBalance() { return monthlyIncome - totalSpent(); }
function spendingHabitInsight() {
    if (monthlyIncome <= 0) return "Add income to compare spending with your budget period";
    const spent = totalSpent();
    if (spent <= 0) return "No spending recorded this period";
    const spentPercent = Math.round((spent / monthlyIncome) * 100);
    const start = Date.parse(String(budgetStartDate) + "T00:00:00Z");
    const end = Date.parse(String(budgetEndDate) + "T00:00:00Z");
    if (!Number.isFinite(start) || !Number.isFinite(end) || end < start) return spentPercent + "% of income spent this period";
    const totalDays = Math.floor((end - start) / 86400000) + 1;
    const todayTime = Date.parse(localDateISO() + "T00:00:00Z");
    const elapsedDays = todayTime < start ? 0 : Math.min(totalDays, Math.floor((todayTime - start) / 86400000) + 1);
    const elapsedPercent = Math.round((elapsedDays / totalDays) * 100);
    const difference = spentPercent - elapsedPercent;
    const pace = difference > 10 ? "Ahead of period pace" : difference < -10 ? "Below period pace" : "Close to period pace";
    return pace + " · " + spentPercent + "% of income spent; " + elapsedPercent + "% of period elapsed";
}
function findEnvelope(name) { return envelopes.find(e => e.name === name); }
function setText(id, value) { const el = $(id); if (el) el.textContent = value; }
function showPage(id, { fromHistory = false, replaceHistory = false } = {}) {
    if (isRestrictedFamilyMember() && ["setupPage", "editEnvelopePage", "addEnvelopePage", "transferPage"].includes(id)) {
        setText("familyProfileStatus", familyAdminOnlyMessage());
        id = "homePage";
    }
    if (!fromHistory && id !== currentVisiblePageId) {
        const pageState = { ...(window.history.state || {}), monetatribePage: id };
        if (id === "sessionLoadingPage" || !initialPageResolved || replaceHistory) window.history.replaceState(pageState, "", window.location.href);
        else window.history.pushState(pageState, "", window.location.href);
    }
    pageIds.forEach(pageId => { const el = $(pageId); if (el) el.hidden = pageId !== id; });
    currentVisiblePageId = id;
    if (id !== "sessionLoadingPage") initialPageResolved = true;
    window.scrollTo({ top: 0, behavior: "auto" });
}

window.addEventListener("popstate", event => {
    const targetPage = event.state?.monetatribePage;
    if (!pageIds.includes(targetPage)) return;
    const publicPages = ["sessionLoadingPage", "loginPage", "createAccountPage", "resetPasswordPage"];
    let pageToShow = targetPage;
    if (!activeUser && !publicPages.includes(pageToShow)) pageToShow = "loginPage";
    else if (activeUser && publicPages.includes(pageToShow) && !passwordRecoveryActive) pageToShow = "homePage";
    else if (activeUser && !publicPages.includes(pageToShow) && pageToShow !== "homePage") pageToShow = "homePage";
    if (pageToShow !== targetPage) {
        window.history.replaceState({ ...(event.state || {}), monetatribePage: pageToShow }, "", window.location.href);
    }
    showPage(pageToShow, { fromHistory: true });
});

document.addEventListener("keydown", event => {
    if (event.key !== "Backspace" || event.altKey || event.ctrlKey || event.metaKey) return;
    const target = event.target;
    if (target instanceof HTMLElement && target.isContentEditable) return;
    if (target instanceof HTMLElement && target.closest("input, textarea, select, [role='textbox']")) return;
    if (!window.history.state?.monetatribePage || currentVisiblePageId === "homePage") return;
    event.preventDefault();
    window.history.back();
});

// A right swipe returns to the dashboard. Native edge-back gestures are handled
// by browser history and routed there by the popstate handler above.
let pageSwipeStart = null;
document.addEventListener("pointerdown", event => {
    if (event.pointerType !== "touch") return;
    if (event.target instanceof Element && event.target.closest("button, a, input, textarea, select, [contenteditable='true'], .envelope-card-clickable")) return;
    if (event.clientX < 28 || event.clientX > window.innerWidth - 28) return;
    pageSwipeStart = { x: event.clientX, y: event.clientY };
}, { passive: true });
document.addEventListener("pointerup", event => {
    if (!pageSwipeStart || event.pointerType !== "touch") { pageSwipeStart = null; return; }
    const deltaX = event.clientX - pageSwipeStart.x;
    const deltaY = event.clientY - pageSwipeStart.y;
    pageSwipeStart = null;
    if (Math.abs(deltaX) < 90 || Math.abs(deltaY) > 65) return;
    if (!window.history.state?.monetatribePage || currentVisiblePageId === "homePage") return;
    if (deltaX > 0) window.history.back();
}, { passive: true });
document.addEventListener("pointercancel", () => { pageSwipeStart = null; }, { passive: true });
function setMessage(id, message, isError = true) {
    const el = $(id);
    if (!el) return;
    el.textContent = message;
    el.style.color = isError ? "#b42318" : "#176b55";
}
function clearMessage(id) { setMessage(id, "", false); }

function refreshAll({ persist = true } = {}) {
    renderDashboard();
    renderSetup();
    renderAddEnvelopeSummary();
    renderTransactionForm();
    renderHistory();
    renderTransferForm();
    if (persist) saveAppData();
}

// Envelope editing is managed from Budget Setup.
function makeEnvelopeActions(envelopeName) {
    const wrapper = document.createElement("div");
    wrapper.className = "envelope-actions";
    const edit = document.createElement("button");
    edit.type = "button";
    edit.className = "envelope-edit-button";
    edit.textContent = "Edit";
    edit.addEventListener("click", () => openEditEnvelope(envelopeName));
    wrapper.append(edit);
    return wrapper;
}

function renderDashboard() {
    updateCurrencySymbols();
    const demoNotice = $("demoBudgetNotice");
    if (demoNotice) demoNotice.hidden = !isDemoBudget;
    const lastName = getProfileLastName();
    setText("dashboardUserLastName", lastName);
    const avatarButton = $("viewProfileButton");
    const avatarImage = $("dashboardUserAvatar");
    const avatar = getUserAvatar();
    if (avatarImage) {
        avatarImage.src = avatar.path;
        avatarImage.alt = avatar.label;
    }
    if (avatarButton) {
        avatarButton.setAttribute("aria-label", `Open ${lastName === "User" ? "user" : lastName + "'s"} profile`);
        avatarButton.title = `Open ${lastName === "User" ? "user" : lastName + "'s"} profile`;
    }
    const profileToggle = $("budgetProfileToggle");
    if (profileToggle) profileToggle.hidden = !activeFamily;
    const personalButton = $("personalBudgetButton");
    const familyButton = $("familyBudgetButton");
    if (personalButton) {
        personalButton.setAttribute("aria-pressed", String(budgetProfileMode !== "family"));
        personalButton.setAttribute("aria-label", "Personal budget");
    }
    if (familyButton) {
        familyButton.setAttribute("aria-pressed", String(budgetProfileMode === "family"));
        familyButton.textContent = activeFamily?.name || "Family";
        familyButton.title = activeFamily?.name || "Family budget";
        familyButton.setAttribute("aria-label", activeFamily ? `Family budget: ${activeFamily.name}` : "Family budget");
    }
    const restrictedMember = isRestrictedFamilyMember();
    document.querySelectorAll("#homePage .dashboard-actions [data-page]").forEach(button => {
        button.hidden = restrictedMember && ["setupPage", "transferPage"].includes(button.dataset.page);
    });
    const balance = actualBalance();
    const lowBalance = balance < monthlyIncome * 0.3;
    $("homePage")?.classList.toggle("low-balance", lowBalance);
    setText("totalSpent", money(totalSpent()));
    setText("actualBalance", money(balance));
    const spendingInsight = spendingHabitInsight();
    setText("balanceStatusBadge", spendingInsight);
    if ($("balanceStatusBadge")) $("balanceStatusBadge").title = "Compares the share of income spent with the share of the budget period elapsed.";
    if ($("lowBalanceNotice")) $("lowBalanceNotice").hidden = !lowBalance;
    setText("envelopeCount", `${envelopes.length} ${envelopes.length === 1 ? "pocket" : "pockets"}`);
    const days = new Date(new Date().getFullYear(), new Date().getMonth() + 1, 0).getDate() - new Date().getDate();
    setText("daysLeft", String(days));
    const list = $("envelopeList");
    if (!list) return;
    list.replaceChildren();
    list.className = "envelope-list";
    if (!envelopes.length) {
        const empty = document.createElement("p");
        empty.textContent = "No pockets yet. Open Budget Setup to add one.";
        list.appendChild(empty);
        return;
    }
    envelopes.forEach(envelope => {
        const overspent = envelope.spent > envelope.budget;
        const card = document.createElement("article");
        card.className = overspent ? "envelope-card envelope-over-budget" : "envelope-card";
        card.classList.add("envelope-card-clickable");
        card.tabIndex = 0;
        card.setAttribute("role", "button");
        card.setAttribute("aria-label", `View expenses for ${envelope.name}`);
        card.addEventListener("click", () => openPocketExpenseHistory(envelope.name));
        card.addEventListener("keydown", event => {
            if (event.key !== "Enter" && event.key !== " ") return;
            event.preventDefault();
            openPocketExpenseHistory(envelope.name);
        });
        const top = document.createElement("div");
        top.className = "envelope-top";
        const titleGroup = document.createElement("div");
        titleGroup.className = "envelope-title-group";
        const iconBadge = document.createElement("span");
        iconBadge.className = "envelope-icon-badge";
        iconBadge.innerHTML = pocketIconMarkup(envelope.iconKey || inferPocketIconKey(envelope.name));
        iconBadge.setAttribute("aria-hidden", "true");
        const title = document.createElement("h3");
        title.textContent = envelope.name;
        titleGroup.append(iconBadge, title);
        const balance = document.createElement("p");
        balance.className = overspent ? "envelope-balance envelope-negative-balance" : "envelope-balance";
        balance.textContent = money(envelope.budget - envelope.spent);
        top.append(titleGroup, balance);
        const progress = document.createElement("div");
        progress.className = overspent ? "progress-track progress-over-budget" : "progress-track";
        const fill = document.createElement("div");
        fill.className = overspent ? "progress-fill progress-over-budget-fill" : "progress-fill";
        const progressPercent = overspent
            ? (envelope.budget > 0 ? ((envelope.spent - envelope.budget) / envelope.budget) * 100 : 100)
            : (envelope.budget > 0 ? ((envelope.budget - envelope.spent) / envelope.budget) * 100 : 0);
        const remainingPercent = envelope.budget > 0
            ? Math.max(0, Math.min(100, ((envelope.budget - envelope.spent) / envelope.budget) * 100))
            : (envelope.spent > 0 ? 0 : 100);
        const spentPercent = envelope.budget > 0
            ? Math.max(0, (envelope.spent / envelope.budget) * 100)
            : (envelope.spent > 0 ? 100 : 0);
        fill.style.width = `${Math.max(overspent || remainingPercent === 0 ? 1.5 : 0, Math.min(100, progressPercent))}%`;
        fill.style.setProperty("--progress-color", overspent ? "#dc2626" : getProgressSpectrumColor(spentPercent));
        progress.appendChild(fill);
        const amounts = document.createElement("div");
        amounts.className = "envelope-amounts";
        const spent = document.createElement("span");
        spent.textContent = `Spent: ${money(envelope.spent)}`;
        const budget = document.createElement("span");
        budget.textContent = `Budget: ${money(envelope.budget)}`;
        amounts.append(spent, budget);
        card.append(top, progress, amounts);
        list.appendChild(card);
    });
}

function getProgressSpectrumColor(percent) {
    const stops = ["#176b55", "#84cc16", "#eab308", "#f97316", "#dc2626"];
    const position = (Math.max(0, Math.min(100, percent)) / 100) * (stops.length - 1);
    const startIndex = Math.min(stops.length - 2, Math.floor(position));
    const blend = position - startIndex;
    const start = stops[startIndex].match(/[\da-f]{2}/gi).map(value => parseInt(value, 16));
    const end = stops[startIndex + 1].match(/[\da-f]{2}/gi).map(value => parseInt(value, 16));
    const rgb = start.map((value, index) => Math.round(value + (end[index] - value) * blend));
    return `rgb(${rgb.join(", ")})`;
}

function openPocketExpenseHistory(pocketName) {
    historyPocketFilter = pocketName;
    historyViewingArchive = false;
    archivedTransactions = [];
    archivedBudgetIds = [];
    historyManageMode = false;
    archiveManageMode = false;
    clearMessage("historyArchiveMessage");
    if ($("editTransactionForm")) $("editTransactionForm").hidden = true;
    renderHistory();
    showPage("historyPage");
}

function getProfileFullName() {
    const metadata = activeUser?.user_metadata || {};
    const namedValue = [metadata.full_name, metadata.name].find(value => typeof value === "string" && value.trim());
    if (namedValue) return namedValue.trim();
    return [metadata.first_name, metadata.last_name].filter(value => typeof value === "string" && value.trim()).join(" ");
}

function getProfileLastName() {
    const metadata = activeUser?.user_metadata || {};
    const explicitLastName = [metadata.last_name, metadata.family_name].find(value => typeof value === "string" && value.trim());
    if (explicitLastName) return explicitLastName.trim();
    const fullName = getProfileFullName();
    if (fullName) return fullName.split(/\s+/).pop();
    return activeUser?.email?.split("@")[0] || "User";
}

function getUserAvatar() {
    const metadata = activeUser?.user_metadata || {};
    const age = Number(metadata.age);
    const gender = String(metadata.gender || "male").toLowerCase();
    const female = gender === "female";
    if (Number.isFinite(age) && age < 20) return { path: `avatars/teen-${female ? "girl" : "boy"}.svg`, label: female ? "Teen girl avatar" : "Teen boy avatar" };
    if (Number.isFinite(age) && age >= 60) return { path: `avatars/${female ? "grandma" : "grandpa"}.svg`, label: female ? "Grandma avatar" : "Grandpa avatar" };
    return { path: `avatars/adult-${female ? "woman" : "man"}.svg`, label: female ? "Adult woman avatar" : "Adult man avatar" };
}

function setProfileEditing(isEditing) {
    const form = $("editProfileForm");
    if (!form) return;
    form.classList.toggle("is-editing", isEditing);
    form.querySelectorAll(".profile-edit-control").forEach(control => { control.hidden = !isEditing; });
    $("profileName").hidden = isEditing;
    $("profileAge").hidden = isEditing;
    $("profileGender").hidden = isEditing;
    $("profileCurrency").hidden = isEditing;
    $("editProfileButton").hidden = isEditing;
    form.querySelector('button[type="submit"]').hidden = !isEditing;
    $("cancelEditProfile").hidden = !isEditing;
    $("profileCurrencyNote").hidden = !isEditing;
    $("editProfileMessage").hidden = !isEditing;
}

function renderProfile() {
    const metadata = activeUser?.user_metadata || {};
    setProfileEditing(false);
    updateCurrencySymbols();
    const fullName = getProfileFullName();
    setText("profileName", fullName || "Not provided");
    setText("profileEmail", activeUser?.email || "Not available");
    setText("profilePhone", activeUser?.phone || metadata.phone || metadata.phone_number || "Not provided");
    setText("profileAge", metadata.age ? `${metadata.age} years` : "Not provided");
    setText("profileGender", metadata.gender ? (String(metadata.gender).charAt(0).toUpperCase() + String(metadata.gender).slice(1)) : "Not provided");
    setText("profileCurrency", currencyLabel());
    const createdAt = activeUser?.created_at ? new Date(activeUser.created_at) : null;
    const createdAtText = createdAt && !Number.isNaN(createdAt.getTime())
        ? formatAppDate(createdAt)
        : "Not available";
    setText("profileCreatedAt", createdAtText);
    const hasFamily = Boolean(activeFamily);
    $("familyForms").hidden = hasFamily || !familySchemaAvailable;
    $("familyDetails").hidden = !hasFamily;
    $("deleteFamilyButton").hidden = !hasFamily || !isActiveFamilyAdmin();
    setText("familyProfileStatus", !familySchemaAvailable
        ? familySetupRequiredMessage()
        : hasFamily
            ? `${isActiveFamilyAdmin() ? "You are the Family Admin." : (activeFamilyRestricted ? "You can add expense transactions only." : "You can manage the shared budget.")} Switch profiles from the dashboard header.`
            : "Create a family budget or join one with a member’s six digit code.");
    if (hasFamily) {
        setText("familyNameDisplay", activeFamily.name);
        setText("familyCodeDisplay", activeFamily.invite_code);
        loadFamilyMembers();
    }
}

function renderFamilyMemberRows(container, members) {
    if (!container) return;
    container.replaceChildren();
    if (!members.length) {
        container.textContent = "No family members found.";
        return;
    }
    members.forEach(member => {
        const row = document.createElement("div");
        row.className = "family-member-row";
        const avatar = document.createElement("span");
        avatar.className = "family-member-avatar";
        avatar.setAttribute("aria-hidden", "true");
        const appearance = familyTransactionAuthor(member.member_user_id);
        avatar.textContent = appearance.initials;
        avatar.style.backgroundColor = appearance.background;
        avatar.style.color = appearance.foreground;
        const info = document.createElement("span");
        info.className = "family-member-info";
        const name = document.createElement("strong");
        const roleLabel = member.role === "admin" ? " · Admin" : "";
        name.textContent = `${member.display_name || "Family member"}${member.member_user_id === activeUser?.id ? " (You)" : ""}${roleLabel}`;
        const joined = document.createElement("small");
        const joinedAt = member.joined_at ? new Date(member.joined_at) : null;
        joined.textContent = joinedAt && !Number.isNaN(joinedAt.getTime())
            ? "Joined " + formatAppDate(joinedAt)
            : "Family member";
        info.append(name, joined);
        row.append(avatar, info);
        if (isActiveFamilyAdmin() && member.role !== "admin") {
            const restrictionButton = document.createElement("button");
            restrictionButton.type = "button";
            restrictionButton.className = "envelope-edit-button family-restriction-button";
            restrictionButton.textContent = member.is_restricted ? "Allow Changes" : "Restrict";
            restrictionButton.setAttribute("aria-label", `${member.is_restricted ? "Allow changes for" : "Restrict"} ${member.display_name || "family member"}`);
            restrictionButton.addEventListener("click", () => setFamilyMemberRestriction(member, !member.is_restricted, restrictionButton));
            row.append(restrictionButton);
        } else if (member.role !== "admin") {
            const status = document.createElement("small");
            status.className = "family-restriction-status";
            status.textContent = member.is_restricted ? "Restricted · Add transactions only" : "Full access";
            row.append(status);
        }
        container.append(row);
    });
}

async function setFamilyMemberRestriction(member, restricted, button) {
    if (!isActiveFamilyAdmin() || !activeFamily || member.member_user_id === activeUser?.id) return;
    button.disabled = true;
    try {
        const { error } = await supabaseClient.rpc("set_family_member_restriction", {
            target_user_id: member.member_user_id,
            restrict_member: restricted
        });
        if (error) throw new Error(error.code === "PGRST202" ? familyMembersSetupRequiredMessage() : error.message);
        const cached = familyMembersCache.get(activeFamily.id);
        if (cached) {
            const members = cached.members.map(item => item.member_user_id === member.member_user_id ? { ...item, is_restricted: restricted } : item);
            familyMembersCache.set(activeFamily.id, { savedAt: Date.now(), members });
            [$("familyMemberList")].filter(Boolean).forEach(container => renderFamilyMemberRows(container, members));
        }
    } catch (error) {
        alert(`Member access could not be updated: ${error.message}`);
        button.disabled = false;
    }
}

async function loadFamilyMembers() {
    if (!activeFamily) return [];
    const familyId = activeFamily.id;
    const containers = [$("familyMemberList")].filter(Boolean);
    const cached = familyMembersCache.get(familyId);
    if (cached && Date.now() - cached.savedAt < 60000) {
        containers.forEach(container => renderFamilyMemberRows(container, cached.members));
        setText("familyMemberCount", `${cached.members.length} ${cached.members.length === 1 ? "member" : "members"}`);
        return cached.members;
    }

    let request = familyMembersPromises.get(familyId);
    if (!request) {
        familyMembersLoading.add(familyId);
        containers.forEach(container => { container.textContent = "Loading family members…"; });
        request = (async () => {
            try {
                const { data, error } = await supabaseClient.rpc("get_family_members");
                if (familyId !== activeFamily?.id) return [];
                if (error) {
                    const message = error.code === "PGRST202" ? familyMembersSetupRequiredMessage() : `Could not load family members: ${error.message}`;
                    containers.forEach(container => { container.textContent = message; });
                    return [];
                }
                const members = Array.isArray(data) ? data : [];
                familyMembersCache.set(familyId, { savedAt: Date.now(), members });
                const self = members.find(member => member.member_user_id === activeUser?.id);
                if (self) {
                    activeFamilyRole = self.role;
                    activeFamilyRestricted = Boolean(self.is_restricted);
                }
                containers.forEach(container => renderFamilyMemberRows(container, members));
                setText("familyMemberCount", `${members.length} ${members.length === 1 ? "member" : "members"}`);
                return members;
            } catch (error) {
                containers.forEach(container => { container.textContent = `Could not load family members: ${error.message}`; });
                return [];
            } finally {
                familyMembersLoading.delete(familyId);
                familyMembersPromises.delete(familyId);
            }
        })();
        familyMembersPromises.set(familyId, request);
    }
    return request;
}

function familyTransactionAuthor(userId) {
    const members = activeFamily ? familyMembersCache.get(activeFamily.id)?.members || [] : [];
    const member = members.find(item => item.member_user_id === userId);
    const name = member?.display_name || (userId === activeUser?.id ? getProfileFullName() : "Family member");
    const nameParts = String(name || "Family member").trim().split(/\s+/).filter(Boolean);
    const initials = nameParts.length > 1
        ? `${nameParts[0][0]}${nameParts[nameParts.length - 1][0]}`.toUpperCase()
        : (nameParts[0]?.[0] || "?").toUpperCase();
    const seed = `${activeFamily?.id || "family"}:${userId || "unknown"}`;
    let hash = 2166136261;
    for (let i = 0; i < seed.length; i++) hash = Math.imul(hash ^ seed.charCodeAt(i), 16777619);
    const hue = (hash >>> 0) % 360;
    return { name, initials, background: `hsl(${hue} 72% 88%)`, foreground: `hsl(${hue} 55% 27%)` };
}

function ensureHistoryFamilyMembersLoaded() {
    if (budgetProfileMode !== "family" || !activeFamily) return;
    const familyId = activeFamily.id;
    const cached = familyMembersCache.get(familyId);
    if (cached && Date.now() - cached.savedAt < 60000) return;
    loadFamilyMembers().then(members => {
        if (members.length && currentVisiblePageId === "historyPage" && familyId === activeFamily?.id) renderHistory();
    });
}

function renderSetup() {
    setText("setupIncome", money(monthlyIncome));
    setText("setupBudgeted", money(totalBudget()));
    setText("setupUnallocated", money(availableIncome()));
    setText("setupEnvelopeCount", `${envelopes.length} ${envelopes.length === 1 ? "pocket" : "pockets"}`);
    const incomeInput = $("monthlyIncomeInput");
    if (incomeInput && document.activeElement !== incomeInput) incomeInput.value = monthlyIncome;
    const startInput = $("budgetStartDateInput");
    const endInput = $("budgetEndDateInput");
    if (startInput) startInput.value = budgetStartDate;
    if (endInput) endInput.value = budgetEndDate;
    const cycleModeInput = $("budgetCycleMode");
    if (cycleModeInput) cycleModeInput.value = budgetCycleMode;
    const list = $("setupEnvelopeList");
    if (!list) return;
    list.replaceChildren();
    envelopes.forEach(envelope => {
        const row = document.createElement("div");
        row.className = "setup-pocket-row";
        const identity = document.createElement("div");
        identity.className = "setup-pocket-name";
        const iconBadge = document.createElement("span");
        iconBadge.className = "setup-envelope-icon";
        iconBadge.innerHTML = pocketIconMarkup(envelope.iconKey || inferPocketIconKey(envelope.name));
        iconBadge.setAttribute("aria-hidden", "true");
        const name = document.createElement("strong");
        name.textContent = envelope.name;
        identity.append(iconBadge, name);
        const budgetMetric = document.createElement("div");
        budgetMetric.className = "setup-pocket-budget";
        const budgetLabel = document.createElement("span");
        budgetLabel.textContent = "Budgeted";
        const budgetAmount = document.createElement("strong");
        budgetAmount.textContent = money(envelope.budget);
        budgetMetric.append(budgetLabel, budgetAmount);
        row.append(identity, budgetMetric, makeEnvelopeActions(envelope.name));
        list.appendChild(row);
    });
    const total = document.createElement("p");
    total.className = "setup-total-budget";
    total.textContent = `Total allocated: ${money(totalBudget())}`;
    list.appendChild(total);
}

function renderAddEnvelopeSummary() {
    setText("addEnvelopeIncome", money(monthlyIncome));
    setText("addEnvelopeBudgeted", money(totalBudget()));
    setText("addEnvelopeAvailable", money(availableIncome()));
}

let editingEnvelopeName = null;

function openEditEnvelope(name) {
    const envelope = findEnvelope(name);
    if (!envelope) return;
    editingEnvelopeName = envelope.name;
    $("editEnvelopeName").value = envelope.name;
    renderPocketIconPicker("editPocketIconPicker", "editEnvelopeIcon", envelope.iconKey || inferPocketIconKey(envelope.name));
    const hasPreviousBudget = Object.prototype.hasOwnProperty.call(previousEnvelopeBudgets, envelope.name);
    const suggestedBudget = Number(previousEnvelopeBudgets[envelope.name]);
    $("editEnvelopeBudget").value = envelope.budget > 0 ? envelope.budget : (hasPreviousBudget ? suggestedBudget : envelope.budget);
    setText("editEnvelopePreviousBudgetNote", hasPreviousBudget ? `Previous budget: ${money(suggestedBudget)}. This amount was filled in for you.` : "");
    setText("editEnvelopeSpentNote", `Already spent: ${money(envelope.spent)}`);
    setText("editEnvelopeUnallocated", `Unallocated amount: ${money(availableIncome())}`);
    clearMessage("editEnvelopeMessage");
    showPage("editEnvelopePage");
}

function saveEnvelopeEdits() {
    const envelope = findEnvelope(editingEnvelopeName);
    if (!envelope) return setMessage("editEnvelopeMessage", "Pocket not found.");
    const newName = $("editEnvelopeName").value.trim();
    const newBudget = Number($("editEnvelopeBudget").value);
    const newIconKey = normalizePocketIconKey($("editEnvelopeIcon").value, newName);
    if (!newName) return setMessage("editEnvelopeMessage", "Enter a pocket name.");
    if (envelopes.some(e => e !== envelope && e.name.toLowerCase() === newName.toLowerCase())) return setMessage("editEnvelopeMessage", "A pocket with this name already exists.");
    if (!Number.isFinite(newBudget) || newBudget < 0) return setMessage("editEnvelopeMessage", "Budget must be zero or greater.");
    if (totalBudget() - envelope.budget + newBudget > monthlyIncome) return setMessage("editEnvelopeMessage", "Total budgets cannot exceed monthly income.");
    const oldName = envelope.name;
    envelope.name = newName;
    envelope.budget = newBudget;
    envelope.iconKey = newIconKey;
    if (Object.prototype.hasOwnProperty.call(previousEnvelopeBudgets, oldName)) {
        previousEnvelopeBudgets[newName] = previousEnvelopeBudgets[oldName];
        if (newName !== oldName) delete previousEnvelopeBudgets[oldName];
    }
    transactions.forEach(t => {
        if (t.envelope === oldName) t.envelope = newName;
        if (t.source === oldName) t.source = newName;
        if (t.destination === oldName) t.destination = newName;
    });
    editingEnvelopeName = newName;
    refreshAll();
    showPage("setupPage");
}

function deleteEnvelope(name) {
    const envelope = findEnvelope(name);
    if (!envelope) return;
    const hasHistory = transactions.some(t => t.envelope === name || t.source === name || t.destination === name);
    if (hasHistory || envelope.spent > 0) return setMessage("editEnvelopeMessage", "This pocket has spending or transfer history and cannot be deleted.");
    if (!confirm(`Delete the pocket “${name}”?`)) return;
    envelopes = envelopes.filter(e => e !== envelope);
    editingEnvelopeName = null;
    refreshAll();
    showPage("setupPage");
}

function renderTransactionForm() {
    const select = $("transactionEnvelope");
    if (!select) return;
    const previous = select.value;
    select.replaceChildren();
    const placeholder = document.createElement("option");
    placeholder.value = "";
    placeholder.textContent = "Select a pocket";
    select.appendChild(placeholder);
    envelopes.forEach(e => {
        const option = document.createElement("option");
        option.value = e.name;
        option.textContent = e.name;
        select.appendChild(option);
    });
    if (envelopes.some(e => e.name === previous)) select.value = previous;
    const date = $("transactionDate");
    if (date && !date.value) date.value = new Date().toISOString().slice(0, 10);
}

function renderHistory() {
    const list = $("transactionHistoryList");
    if (!list) return;
    const restrictedMember = isRestrictedFamilyMember();
    if (restrictedMember) {
        historyManageMode = false;
        archiveManageMode = false;
    }
    ensureHistoryFamilyMembersLoaded();
    list.replaceChildren();
    const archiveFrom = $("previousTransactionsFrom")?.value || "";
    const archiveTo = $("previousTransactionsTo")?.value || "";
    const invalidArchiveRange = historyViewingArchive && archiveFrom && archiveTo && archiveFrom > archiveTo;
    const currentOrArchived = historyViewingArchive
        ? archivedTransactions.filter(t => (!archiveFrom || String(t.date || "") >= archiveFrom) && (!archiveTo || String(t.date || "") <= archiveTo))
        : transactions;
    const shownTransactions = historyPocketFilter
        ? currentOrArchived.filter(t => t.type === "expense" && t.envelope === historyPocketFilter)
        : currentOrArchived;
    const countLabel = historyPocketFilter
        ? `${shownTransactions.length} ${shownTransactions.length === 1 ? "expense" : "expenses"} · ${historyPocketFilter}`
        : `${shownTransactions.length} ${shownTransactions.length === 1 ? "transaction" : "transactions"}`;
    setText("historyCount", `${countLabel}${historyViewingArchive ? " · Previous budgets" : ""}`);
    setText("historyTitle", historyPocketFilter || "Transaction History");
    setText("historySubtitle", historyPocketFilter ? "Expenses" : "Review your recorded transactions");
    setText("historyPocketFilterText", `Showing expenses for ${historyPocketFilter || ""}`);
    const filterNotice = $("historyPocketFilterNotice");
    if (filterNotice) filterNotice.hidden = !historyPocketFilter;
    const emptyMessage = historyPocketFilter
        ? historyViewingArchive ? `No previous expenses for ${historyPocketFilter} match these dates.` : `No expenses for ${historyPocketFilter} in this budget period.`
        : historyViewingArchive ? (archivedTransactions.length ? "No previous transactions match these dates." : "No previous transactions have been recorded.") : "No transactions recorded yet.";
    setText("historyEmptyMessage", invalidArchiveRange ? "From date must be on or before To date." : shownTransactions.length ? "" : emptyMessage);
    const toggle = $("toggleHistoryManagement");
    if (toggle) toggle.textContent = historyManageMode ? "Done" : "Edit Transactions";
    if (toggle) toggle.hidden = historyViewingArchive || restrictedMember || Boolean(historyPocketFilter);
    const previousToggle = $("togglePreviousTransactions");
    if (previousToggle) previousToggle.textContent = historyViewingArchive ? "View Current Transactions" : "Previous Transactions";
    const archiveFilters = $("previousTransactionsFilters");
    if (archiveFilters) archiveFilters.hidden = !historyViewingArchive;
    const archiveActions = $("previousTransactionsActions");
    if (archiveActions) archiveActions.hidden = !historyViewingArchive || restrictedMember || Boolean(historyPocketFilter);
    const archiveManageToggle = $("togglePreviousTransactionsManagement");
    if (archiveManageToggle) archiveManageToggle.textContent = archiveManageMode ? "Done Editing Previous Transactions" : "Edit Previous Transactions";
    if (archiveManageToggle) archiveManageToggle.hidden = restrictedMember || Boolean(historyPocketFilter);
    const deleteAllArchiveButton = $("deleteAllPreviousTransactions");
    if (deleteAllArchiveButton) deleteAllArchiveButton.hidden = restrictedMember || Boolean(historyPocketFilter) || !archiveManageMode || archivedTransactions.length === 0;
    const panel = $("historyManagementPanel");
    if (panel) panel.hidden = restrictedMember || Boolean(historyPocketFilter) || !historyManageMode || historyViewingArchive;
    const editForm = $("editTransactionForm");
    if (historyViewingArchive && editForm) editForm.hidden = true;
    [...shownTransactions].sort((a, b) => String(b.date || "").localeCompare(String(a.date || ""))).forEach(t => {
        const row = document.createElement("div");
        row.className = "transaction-item";
        let authorAvatar = null;
        if (budgetProfileMode === "family" && activeFamily) {
            const author = familyTransactionAuthor(t.userId || activeUser?.id);
            authorAvatar = document.createElement("span");
            authorAvatar.className = "family-transaction-author";
            authorAvatar.setAttribute("role", "img");
            authorAvatar.setAttribute("aria-label", `${author.name} entered this ${t.type === "expense" ? "expense" : "transaction"}`);
            authorAvatar.title = `${author.name} entered this ${t.type === "expense" ? "expense" : "transaction"}`;
            authorAvatar.textContent = author.initials;
            authorAvatar.style.backgroundColor = author.background;
            authorAvatar.style.color = author.foreground;
        }
        const details = document.createElement("div"); details.className = "transaction-main-details";
        const desc = document.createElement("strong"); desc.textContent = t.description || (t.type === "transfer" ? "Budget transfer" : "Expense");
        const category = document.createElement("span"); category.textContent = t.type === "transfer" ? `${t.source} → ${t.destination}` : (t.envelope || "—");
        const date = document.createElement("span"); date.className = "transaction-date"; date.textContent = formatAppDate(t.date);
        details.append(desc, category, date);
        const amount = document.createElement("strong"); amount.className = "transaction-amount"; amount.textContent = money(t.amount);
        row.append(details, amount);
        if (authorAvatar) row.appendChild(authorAvatar);
        if (historyManageMode && !historyViewingArchive) {
            const actions = document.createElement("div"); actions.className = "transaction-actions";
            if (t.type !== "transfer") {
                const edit = document.createElement("button"); edit.type = "button"; edit.className = "secondary-button"; edit.textContent = "Modify";
                edit.addEventListener("click", () => openTransactionEditor(t)); actions.appendChild(edit);
            }
            const remove = document.createElement("button"); remove.type = "button"; remove.className = "danger-button"; remove.textContent = "Delete";
            remove.addEventListener("click", () => deleteSingleTransaction(t.id)); actions.appendChild(remove);
            row.appendChild(actions);
        }
        if (archiveManageMode && historyViewingArchive) {
            const actions = document.createElement("div"); actions.className = "transaction-actions";
            const remove = document.createElement("button"); remove.type = "button"; remove.className = "danger-button"; remove.textContent = "Delete";
            remove.addEventListener("click", () => deletePreviousTransaction(t.id, t.budgetId));
            actions.appendChild(remove);
            row.appendChild(actions);
        }
        list.appendChild(row);
    });
}

async function togglePreviousBudgetTransactions() {
    if (historyViewingArchive) {
        historyViewingArchive = false;
        archivedTransactions = [];
        archivedBudgetIds = [];
        archiveManageMode = false;
        historyManageMode = false;
        clearMessage("historyArchiveMessage");
        renderHistory();
        return;
    }
    if (!activeUser || !budgetStartDate) {
        setText("historyArchiveMessage", "Previous budget history is available after a budget has been saved.");
        return;
    }
    const previousBudgets = await fetchAllSupabaseRows(() => {
        let query = supabaseClient.from("monthly_budgets").select("id,start_date,end_date")
            .lt("end_date", localDateISO()).order("start_date", { ascending: false });
        query = budgetProfileMode === "family" && activeFamily
            ? query.eq("family_id", activeFamily.id)
            : familySchemaAvailable
                ? query.eq("user_id", activeUser.id).is("family_id", null)
                : query.eq("user_id", activeUser.id);
        if (cloudBudgetId) query = query.neq("id", cloudBudgetId);
        return query;
    });
    if (!previousBudgets?.length) {
        archivedBudgetIds = [];
        setText("historyArchiveMessage", "There are no previous budget periods yet.");
        return;
    }
    const previousBudgetIds = previousBudgets.map(b => b.id);
    archivedBudgetIds = previousBudgetIds;
    const idChunks = [];
    for (let i = 0; i < previousBudgetIds.length; i += 100) idChunks.push(previousBudgetIds.slice(i, i + 100));
    const [envelopePages, transactionPages] = await Promise.all([
        Promise.all(idChunks.map(ids => fetchAllSupabaseRows(() => supabaseClient.from("envelopes").select("id,name").in("budget_id", ids)))),
        Promise.all(idChunks.map(ids => fetchAllSupabaseRows(() => supabaseClient.from("transactions").select("*").in("budget_id", ids).order("transaction_date", { ascending: false }))))
    ]);
    const dbEnvelopes = envelopePages.flat();
    const dbTransactions = transactionPages.flat();
    const envelopeNames = new Map((dbEnvelopes || []).map(e => [e.id, e.name]));
    archivedTransactions = (dbTransactions || []).map(t => ({
        id: t.id, userId: t.user_id, budgetId: t.budget_id, type: t.transaction_type, date: t.transaction_date, amount: Number(t.amount), description: t.description || "",
        envelope: envelopeNames.get(t.envelope_id) || "",
        source: t.transaction_type === "transfer" ? envelopeNames.get(t.envelope_id) : undefined,
        destination: t.transfer_to_envelope_id ? envelopeNames.get(t.transfer_to_envelope_id) : undefined
    }));
    clearMessage("historyArchiveMessage");
    historyViewingArchive = true;
    historyManageMode = false;
    archiveManageMode = false;
    renderHistory();
}

async function deletePreviousTransaction(id, budgetId) {
    const transaction = archivedTransactions.find(item => item.id === id && item.budgetId === budgetId);
    if (!transaction || !activeUser) return;
    if (!confirm("Delete this previous transaction? This cannot be undone.")) return;
    const { error } = await supabaseClient.from("transactions").delete()
        .eq("budget_id", budgetId).eq("id", id);
    if (error) {
        console.error("Could not delete previous transaction:", error);
        setText("historyArchiveMessage", "This previous transaction could not be deleted. Please try again.");
        return;
    }
    archivedTransactions = archivedTransactions.filter(item => !(item.id === id && item.budgetId === budgetId));
    renderHistory();
    setText("historyArchiveMessage", "Previous transaction deleted.");
}

async function deleteAllPreviousTransactions() {
    const count = archivedTransactions.length;
    if (!activeUser || !archivedBudgetIds.length || !count) return;
    if (!confirm(`Delete all ${count} previous transactions from every expired budget period? This cannot be undone.`)) return;
    const button = $("deleteAllPreviousTransactions");
    if (button) button.disabled = true;
    try {
        for (let i = 0; i < archivedBudgetIds.length; i += 100) {
            const ids = archivedBudgetIds.slice(i, i + 100);
            const { error } = await supabaseClient.from("transactions").delete()
                .in("budget_id", ids);
            if (error) throw error;
        }
        archivedTransactions = [];
        renderHistory();
        setText("historyArchiveMessage", `Deleted ${count} previous transaction${count === 1 ? "" : "s"}.`);
    } catch (error) {
        console.error("Could not delete all previous transactions:", error);
        setText("historyArchiveMessage", "Previous transactions could not all be deleted. Please reload the archive and try again.");
    } finally {
        if (button) button.disabled = false;
    }
}

async function fetchAllSupabaseRows(makeQuery) {
    const pageSize = 1000;
    const rows = [];
    for (let offset = 0; ; offset += pageSize) {
        const { data, error } = await makeQuery().range(offset, offset + pageSize - 1);
        if (error) throw error;
        rows.push(...(data || []));
        if (!data || data.length < pageSize) return rows;
    }
}

function openTransactionEditor(transaction) {
    if (!transaction || transaction.type === "transfer") return;
    const form = $("editTransactionForm");
    const select = $("editTransactionEnvelope");
    select.replaceChildren();
    envelopes.forEach(envelope => {
        const option = document.createElement("option"); option.value = envelope.name; option.textContent = envelope.name; select.appendChild(option);
    });
    $("editTransactionId").value = String(transaction.id);
    $("editTransactionDate").value = transaction.date || "";
    $("editTransactionAmount").value = transaction.amount;
    $("editTransactionEnvelope").value = transaction.envelope;
    $("editTransactionDescription").value = transaction.description || "";
    clearMessage("editTransactionMessage");
    form.hidden = false;
    form.scrollIntoView({ behavior: "smooth", block: "start" });
}

function saveEditedTransaction(event) {
    event.preventDefault();
    const id = $("editTransactionId").value;
    const old = transactions.find(t => String(t.id) === id);
    if (!old || old.type === "transfer") return setMessage("editTransactionMessage", "This transaction could not be found. Refresh the history and try again.");
    const nextEnvelope = findEnvelope($("editTransactionEnvelope").value);
    const amount = Number($("editTransactionAmount").value);
    const date = $("editTransactionDate").value;
    const description = $("editTransactionDescription").value.trim();
    if (!nextEnvelope || !date || !description || !Number.isFinite(amount) || amount <= 0) return setMessage("editTransactionMessage", "Complete all fields with a valid amount.");
    const oldEnvelope = findEnvelope(old.envelope);
    if (oldEnvelope) oldEnvelope.spent = Math.max(0, oldEnvelope.spent - Number(old.amount));
    nextEnvelope.spent += amount;
    old.envelope = nextEnvelope.name; old.amount = amount; old.date = date; old.description = description;
    $("editTransactionForm").hidden = true;
    clearMessage("editTransactionMessage");
    refreshAll();
    historyManageMode = true;
    renderHistory();
    setMessage("historyManagementMessage", "Transaction changes saved.", false);
}

function reverseTransaction(t) {
    const amount = Number(t.amount) || 0;
    if (t.type === "transfer") {
        const source = findEnvelope(t.source);
        const destination = findEnvelope(t.destination);
        if (destination && destination.budget - amount < destination.spent) {
            return `Cannot delete this transfer because ${destination.name} has already spent some of the transferred budget. Reduce its spending or adjust the budget first.`;
        }
        if (source) source.budget += amount;
        if (destination) destination.budget -= amount;
    } else {
        const envelope = findEnvelope(t.envelope);
        if (envelope) envelope.spent = Math.max(0, envelope.spent - amount);
    }
    return "";
}

function deleteSingleTransaction(id) {
    const transaction = transactions.find(t => t.id === id);
    if (!transaction) return;
    if (!confirm("Delete this transaction? The pocket balance will be adjusted.")) return;
    const error = reverseTransaction(transaction);
    if (error) { setMessage("historyManagementMessage", error); return; }
    transactions = transactions.filter(t => t.id !== id);
    clearMessage("historyManagementMessage");
    refreshAll();
}

function deleteTransactionsByPeriod() {
    const from = $("deleteTransactionsFrom").value;
    const to = $("deleteTransactionsTo").value;
    if (!from || !to) return setMessage("historyManagementMessage", "Choose both a from date and a to date.");
    if (from > to) return setMessage("historyManagementMessage", "The from date must be on or before the to date.");
    const selected = transactions.filter(t => String(t.date || "") >= from && String(t.date || "") <= to)
        .sort((a, b) => String(b.date || "").localeCompare(String(a.date || "")));
    if (!selected.length) return setMessage("historyManagementMessage", "No transactions were found in that date range.", false);
    if (!confirm(`Delete ${selected.length} transaction(s) dated ${from} through ${to}? Pocket balances will be adjusted.`)) return;
    for (const t of selected) {
        const error = reverseTransaction(t);
        if (error) { refreshAll(); return setMessage("historyManagementMessage", error); }
        transactions = transactions.filter(item => item.id !== t.id);
    }
    refreshAll();
    setMessage("historyManagementMessage", `Deleted ${selected.length} transaction(s).`, false);
}

function deleteAllTransactions() {
    if (!transactions.length) return setMessage("historyManagementMessage", "There are no transactions to delete.", false);
    if (!confirm(`Delete all ${transactions.length} transactions? Pocket balances will be adjusted.`)) return;
    const selected = [...transactions].sort((a, b) => String(b.date || "").localeCompare(String(a.date || "")));
    for (const t of selected) {
        const error = reverseTransaction(t);
        if (error) { refreshAll(); return setMessage("historyManagementMessage", error); }
        transactions = transactions.filter(item => item.id !== t.id);
    }
    refreshAll();
    setMessage("historyManagementMessage", `Deleted all ${selected.length} transaction(s).`, false);
}

function renderTransferForm() {
    setText("transferAvailable", money(totalBudget()));
    [$("transferFrom"), $("transferTo")].forEach((select, index) => {
        if (!select) return;
        const old = select.value;
        select.replaceChildren();
        const placeholder = document.createElement("option");
        placeholder.value = "";
        placeholder.textContent = index === 0 ? "Select source pocket" : "Select destination pocket";
        select.appendChild(placeholder);
        envelopes.forEach(e => {
            const option = document.createElement("option");
            option.value = e.name; option.textContent = e.name; select.appendChild(option);
        });
        if (envelopes.some(e => e.name === old)) select.value = old;
    });
    updateSourceBalance();
}

function updateSourceBalance() {
    const source = findEnvelope($("transferFrom")?.value);
    const card = $("sourceBalanceCard");
    if (card) card.hidden = !source;
    if (!source) {
        setText("sourceBudget", money(0)); setText("sourceSpent", money(0)); setText("sourceAvailable", money(0));
        return;
    }
    setText("sourceBudget", money(source.budget));
    setText("sourceSpent", money(source.spent));
    setText("sourceAvailable", money(source.budget - source.spent));
}

// ==================== PASSWORD RECOVERY ====================

function showNewPasswordForm() {
    passwordRecoveryActive = true;
    $("forgotPasswordForm").hidden = true;
    $("newPasswordForm").hidden = false;
    $("resetPageTitle").textContent = "Choose a new password";
    $("resetPageIntro").textContent = "Your recovery link is verified. Enter and confirm your new password.";
    clearMessage("resetMessage");
    clearMessage("newPasswordMessage");
    showPage("resetPasswordPage");
}

$("forgotPasswordButton")?.addEventListener("click", () => {
    $("resetEmail").value = $("loginEmail").value.trim();
    $("forgotPasswordForm").hidden = false;
    $("newPasswordForm").hidden = true;
    $("resetPageTitle").textContent = "Reset your password";
    $("resetPageIntro").textContent = "Enter your registered email address and we’ll send you a secure reset link.";
    clearMessage("resetMessage");
    clearMessage("newPasswordMessage");
    showPage("resetPasswordPage");
});

$("resetBackToLogin")?.addEventListener("click", () => {
    // Do not sign out here: the recovery session is needed to authorize a password change.
    showPage("loginPage");
});

$("forgotPasswordForm")?.addEventListener("submit", async event => {
    event.preventDefault();
    const email = $("resetEmail").value.trim().toLowerCase();
    const button = $("forgotPasswordForm").querySelector('button[type="submit"]');
    button.disabled = true;
    setMessage("resetMessage", "Sending reset link…", false);

    const { error } = await supabaseClient.auth.resetPasswordForEmail(email, {
        redirectTo: "https://renjumathew7.github.io/MonetaTribe/"
    });
    button.disabled = false;

    if (error) {
        setMessage("resetMessage", error.message);
        return;
    }
    setMessage("resetMessage", "If an account exists for this email, a password reset link has been sent. Please check your inbox.", false);
});

// Supabase exchanges the recovery link for a temporary authenticated session.
// This event must be handled before normal session restoration sends users to the dashboard.
supabaseClient.auth.onAuthStateChange((event) => {
    if (event === "PASSWORD_RECOVERY") {
        passwordRecoveryActive = true;
        showNewPasswordForm();
    }
});

$("newPasswordForm")?.addEventListener("submit", async event => {
    event.preventDefault();
    const password = $("newPassword").value;
    const confirmation = $("confirmNewPassword").value;
    if (password.length < 6) return setMessage("newPasswordMessage", "Password must contain at least 6 characters.");
    if (password !== confirmation) return setMessage("newPasswordMessage", "The passwords do not match.");

    const button = $("newPasswordForm").querySelector('button[type="submit"]');
    button.disabled = true;
    setMessage("newPasswordMessage", "Updating your password…", false);
    const { error } = await supabaseClient.auth.updateUser({ password });
    button.disabled = false;

    if (error) {
        setMessage("newPasswordMessage", error.message);
        return;
    }

    // Password update is complete. End the recovery session and return to login.
    await supabaseClient.auth.signOut();
    budgetProfileCache.clear();
    familyMembersCache.clear();
    familyMembersLoading.clear();
    familyMembersPromises.clear();
    familyMembershipLoadedUserId = null;
    activeUser = null;
    activeFamily = null;
    activeFamilyRole = null;
    activeFamilyRestricted = false;
    budgetProfileMode = "personal";
    cloudBudgetId = null;
    passwordRecoveryActive = false;
    localStorage.removeItem(KEEP_LOGGED_IN_KEY);
    $("keepLoggedIn").checked = false;
    $("newPasswordForm").reset();
    $("forgotPasswordForm").hidden = false;
    $("newPasswordForm").hidden = true;
    $("loginEmail").value = $("resetEmail").value.trim().toLowerCase();
    setMessage("message", "Your password has been updated. Please log in with your new password.", false);
    showPage("loginPage");
});

// ==================== FORM HANDLERS ====================

const REMEMBER_EMAIL_KEY = "monetaTribeRememberedEmail";
const KEEP_LOGGED_IN_KEY = "monetaTribeKeepLoggedIn";
$("keepLoggedIn").checked = localStorage.getItem(KEEP_LOGGED_IN_KEY) === "yes";
const rememberedEmail = localStorage.getItem(REMEMBER_EMAIL_KEY);
if (rememberedEmail) {
    $("loginEmail").value = rememberedEmail;
    $("rememberMe").checked = true;
}

$("loginForm")?.addEventListener("submit", async event => {
    event.preventDefault();
    const email = $("loginEmail").value.trim().toLowerCase();
    const password = $("loginPassword").value;
    const button = $("loginForm").querySelector('button[type="submit"]');
    if (button) button.disabled = true;
    setMessage("message", "Signing in…", false);
    const { data, error } = await supabaseClient.auth.signInWithPassword({ email, password });
    if (button) button.disabled = false;
    if (error) { setMessage("message", error.message); return; }
    activeUser = data.user;
    if ($("rememberMe").checked) localStorage.setItem(REMEMBER_EMAIL_KEY, email);
    else localStorage.removeItem(REMEMBER_EMAIL_KEY);
    localStorage.setItem(KEEP_LOGGED_IN_KEY, $("keepLoggedIn").checked ? "yes" : "no");
    try { await loadCloudData(); clearMessage("message"); showPage("homePage"); }
    catch (err) { setMessage("message", "Signed in, but cloud data could not load: " + err.message); }
});

$("createAccount")?.addEventListener("click", () => showPage("createAccountPage"));
$("backToLogin")?.addEventListener("click", () => showPage("loginPage"));
$("registerForm")?.addEventListener("submit", async event => {
    event.preventDefault();
    const name = $("registerName").value.trim();
    const age = Number($("registerAge").value);
    const gender = $("registerGender").value;
    const email = $("registerEmail").value.trim().toLowerCase();
    const password = $("registerPassword").value;
    const button = $("registerForm").querySelector('button[type="submit"]');
    if (button) button.disabled = true;
    const { data, error } = await supabaseClient.auth.signUp({ email, password, options: { data: { full_name: name, age, gender },emailRedirectTo: 'https://renjumathew7.github.io/MonetaTribe/' } });
    if (button) button.disabled = false;
    if (error) { alert(error.message); return; }
    if (data.session && data.user) {
        activeUser = data.user;
        localStorage.setItem(KEEP_LOGGED_IN_KEY, "no");
        $("keepLoggedIn").checked = false;
        try { await loadCloudData(); showPage("homePage"); }
        catch (err) { alert("Account created, but data setup failed: " + err.message); }
    } else {
        alert("Account created. Check your email to confirm your account, then log in.");
        $("loginEmail").value = email; showPage("loginPage");
    }
});

$("logoutButton")?.addEventListener("click", async () => {
    clearTimeout(budgetRolloverTimer);
    try { await flushPendingCloudSave(); }
    catch (error) { console.error("Could not finish saving before logout:", error); }
    await supabaseClient.auth.signOut();
    localStorage.removeItem(KEEP_LOGGED_IN_KEY);
    $("keepLoggedIn").checked = false;
    budgetProfileCache.clear();
    familyMembersCache.clear();
    familyMembersLoading.clear();
    familyMembersPromises.clear();
    familyMembershipLoadedUserId = null;
    // Reset only in-memory UI state; keep the per-user preference for the next sign-in.
    activeUser = null; activeFamily = null; activeFamilyRole = null; activeFamilyRestricted = false; budgetProfileMode = "personal"; cloudBudgetId = null; historyViewingArchive = false; historyPocketFilter = null; archivedTransactions = []; archivedBudgetIds = []; archiveManageMode = false; showPage("loginPage");
});
$("backToHome")?.addEventListener("click", () => { renderDashboard(); showPage("homePage"); });
$("viewProfileButton")?.addEventListener("click", () => { renderProfile(); showPage("profilePage"); });
$("profileBackToHome")?.addEventListener("click", () => showPage("homePage"));
$("exitFamilyButton")?.addEventListener("click", async () => {
    if (!activeFamily || !activeUser) return;
    const family = activeFamily;
    if (!confirm(`Exit “${family.name}”? Your personal budget will remain, and the family budget will stay available to its other members.`)) return;
    const button = $("exitFamilyButton");
    button.disabled = true;
    try {
        await flushPendingCloudSave();
        const { error } = await supabaseClient.rpc("leave_family");
        if (error) throw new Error(error.code === "PGRST202" ? familyMembersSetupRequiredMessage() : error.message);
        familyMembersCache.delete(family.id);
        budgetProfileCache.delete(`${activeUser.id}:family:${family.id}`);
        activeFamily = null;
        activeFamilyRole = null;
        activeFamilyRestricted = false;
        setBudgetProfilePreference("personal");
        familyMembershipLoadedUserId = activeUser.id;
        await loadCloudData();
        renderProfile();
        showPage("profilePage");
    } catch (error) {
        console.error("Could not exit family:", error);
        setText("familyProfileStatus", `Could not exit the family: ${error.message}`);
    } finally {
        if ($("exitFamilyButton")) $("exitFamilyButton").disabled = false;
    }
});
$("deleteFamilyButton")?.addEventListener("click", async () => {
    if (!activeFamily || !activeUser || !isActiveFamilyAdmin()) return;
    const family = activeFamily;
    const confirmed = confirm(`Permanently delete “${family.name}” and all of its shared budgets, pockets, and transactions? This cannot be undone. Personal budgets will remain.`);
    if (!confirmed) return;
    const button = $("deleteFamilyButton");
    let familyDeleted = false;
    button.disabled = true;
    try {
        await flushPendingCloudSave();
        const { error } = await supabaseClient.rpc("delete_family");
        if (error) throw new Error(error.code === "PGRST202" ? deleteFamilySetupRequiredMessage() : error.message);
        familyDeleted = true;
        familyMembersCache.delete(family.id);
        budgetProfileCache.delete(`${activeUser.id}:family:${family.id}`);
        activeFamily = null;
        activeFamilyRole = null;
        activeFamilyRestricted = false;
        familyMembershipLoadedUserId = activeUser.id;
        setBudgetProfilePreference("personal");
        await loadCloudData();
        renderProfile();
        showPage("profilePage");
    } catch (error) {
        console.error("Could not delete family:", error);
        if (familyDeleted) {
            renderProfile();
            showPage("profilePage");
            setText("familyProfileStatus", `The family was deleted, but your personal budget could not reload: ${error.message}`);
        } else {
            setText("familyProfileStatus", `Family could not be deleted: ${error.message}`);
        }
    } finally {
        if ($("deleteFamilyButton")) $("deleteFamilyButton").disabled = false;
    }
});
async function switchBudgetProfile(mode) {
    if (mode === "family" && !activeFamily) return;
    if (budgetProfileMode === mode) return;
    try { await flushPendingCloudSave(); }
    catch (error) {
        alert("The current budget could not be saved, so the profile was not switched: " + error.message);
        return;
    }
    const previousMode = budgetProfileMode;
    setBudgetProfilePreference(mode);
    historyViewingArchive = false;
    historyPocketFilter = null;
    archivedTransactions = [];
    archivedBudgetIds = [];
    archiveManageMode = false;
    try {
        await syncBudgetProfilePreference(mode);
        await loadCloudData(mode);
        await flushPendingCloudSave();
        showPage("homePage");
    } catch (error) {
        console.error("Could not switch budget profile:", error);
        setBudgetProfilePreference(previousMode);
        try { await syncBudgetProfilePreference(previousMode); } catch (syncError) { console.error("Could not restore the previous profile preference:", syncError); }
        try { await loadCloudData(previousMode); } catch (reloadError) { console.error("Could not restore the previous budget profile:", reloadError); }
        alert("The selected budget profile could not be loaded: " + error.message);
    }
}
$("personalBudgetButton")?.addEventListener("click", () => switchBudgetProfile("personal"));
$("familyBudgetButton")?.addEventListener("click", () => switchBudgetProfile("family"));
$("createFamilyForm")?.addEventListener("submit", async event => {
    event.preventDefault();
    const name = $("newFamilyName").value.trim();
    if (!name) return setMessage("createFamilyMessage", "Enter a family name.");
    const button = $("createFamilyForm").querySelector('button[type="submit"]');
    button.disabled = true;
    try { await flushPendingCloudSave(); }
    catch (err) {
        button.disabled = false;
        return setMessage("createFamilyMessage", "Your personal budget could not be saved, so the family was not created: " + err.message);
    }
    setMessage("createFamilyMessage", "Creating your family…", false);
    const { data, error } = await supabaseClient.rpc("create_family", { family_name_input: name });
    button.disabled = false;
    if (error) return setMessage("createFamilyMessage", error.code === "PGRST202" ? familySetupRequiredMessage() : error.message);
    const created = Array.isArray(data) ? data[0] : data;
    if (!created?.family_id) return setMessage("createFamilyMessage", "The family was created, but its details could not be loaded. Please reopen your profile.");
    activeFamily = { id: created.family_id, name: created.family_name, invite_code: created.invite_code };
    activeFamilyRole = "admin";
    activeFamilyRestricted = false;
    familyMembershipLoadedUserId = activeUser.id;
    setBudgetProfilePreference("family");
    try { await loadCloudData("family"); await flushPendingCloudSave(); }
    catch (err) { setMessage("createFamilyMessage", "Family created, but the shared budget could not load: " + err.message); }
    renderProfile();
    showPage("profilePage");
});
$("joinFamilyForm")?.addEventListener("submit", async event => {
    event.preventDefault();
    const code = $("familyInviteCode").value.trim();
    if (!/^\d{6}$/.test(code)) return setMessage("joinFamilyMessage", "Enter the six digit family code.");
    const button = $("joinFamilyForm").querySelector('button[type="submit"]');
    button.disabled = true;
    try { await flushPendingCloudSave(); }
    catch (err) {
        button.disabled = false;
        return setMessage("joinFamilyMessage", "Your current budget could not be saved, so you were not added to the family: " + err.message);
    }
    setMessage("joinFamilyMessage", "Joining family…", false);
    const { data, error } = await supabaseClient.rpc("join_family", { invite_code_input: code });
    button.disabled = false;
    if (error) return setMessage("joinFamilyMessage", error.code === "PGRST202" ? familySetupRequiredMessage() : error.message);
    const joined = Array.isArray(data) ? data[0] : data;
    if (!joined?.family_id) return setMessage("joinFamilyMessage", "The family could not be found. Check the code and try again.");
    activeFamily = { id: joined.family_id, name: joined.family_name, invite_code: joined.invite_code };
    activeFamilyRole = "member";
    activeFamilyRestricted = false;
    familyMembershipLoadedUserId = activeUser.id;
    setBudgetProfilePreference("family");
    try { await loadCloudData("family"); await flushPendingCloudSave(); showPage("homePage"); }
    catch (err) { setMessage("joinFamilyMessage", "You joined the family, but its shared budget could not load: " + err.message); }
});
$("editProfileButton")?.addEventListener("click", () => {
    const metadata = activeUser?.user_metadata || {};
    $("editProfileName").value = getProfileFullName();
    $("editProfileAge").value = metadata.age || "";
    $("editProfileGender").value = metadata.gender || "";
    $("editProfileCurrency").value = getCurrency();
    clearMessage("editProfileMessage");
    setProfileEditing(true);
});
$("cancelEditProfile")?.addEventListener("click", () => {
    clearMessage("editProfileMessage");
    renderProfile();
});
$("editProfileForm")?.addEventListener("submit", async event => {
    event.preventDefault();
    const fullName = $("editProfileName").value.trim();
    const age = Number($("editProfileAge").value);
    const gender = $("editProfileGender").value;
    const currency = $("editProfileCurrency").value;
    if (!fullName) return setMessage("editProfileMessage", "Enter your full name.");
    if (!Number.isInteger(age) || age < 13 || age > 120) return setMessage("editProfileMessage", "Enter an age from 13 to 120.");
    if (gender !== "male" && gender !== "female") return setMessage("editProfileMessage", "Select a gender.");
    if (currency !== "INR" && currency !== "USD") return setMessage("editProfileMessage", "Select INR or USD.");
    const submitButton = $("editProfileForm").querySelector('button[type="submit"]');
    submitButton.disabled = true;
    setMessage("editProfileMessage", "Saving profile…", false);
    const metadata = activeUser?.user_metadata || {};
    const { data, error } = await supabaseClient.auth.updateUser({
        data: { ...metadata, full_name: fullName, age, gender, monetatribe_currency: currency }
    });
    submitButton.disabled = false;
    if (error) return setMessage("editProfileMessage", error.message);
    activeUser = data.user;
    renderProfile();
    renderDashboard();
    clearMessage("editProfileMessage");
});
$("transferBackToHome")?.addEventListener("click", () => showPage("homePage"));
$("cancelAddEnvelope")?.addEventListener("click", () => { clearMessage("addEnvelopeMessage"); showPage("setupPage"); });
$("cancelTransaction")?.addEventListener("click", () => { clearMessage("transactionMessage"); showPage("homePage"); });

// Navigation buttons use the real page IDs in index.html.
document.querySelectorAll("[data-page]").forEach(button => {
    button.addEventListener("click", () => {
        const target = button.dataset.page;
        if (target === "setupPage") renderSetup();
        if (target === "transactionPage") renderTransactionForm();
        if (target === "historyPage") {
            historyPocketFilter = null;
            renderHistory();
        }
        if (target === "transferPage") renderTransferForm();
        showPage(target);
    });
});

$("monthlyIncomeInput")?.addEventListener("change", () => {
    const value = Number($("monthlyIncomeInput").value);
    if (!Number.isFinite(value) || value <= 0) {
        alert("Enter a monthly income greater than zero.");
        renderSetup();
        return;
    }
    if (totalBudget() > value) {
        alert("Monthly income cannot be less than the total pocket budgets.");
        renderSetup();
        return;
    }
    monthlyIncome = value;
    refreshAll();
});

function saveBudgetPeriodDates() {
    const start = $("budgetStartDateInput").value;
    const end = $("budgetEndDateInput").value;
    if (!start || !end) {
        setMessage("budgetPeriodMessage", "Choose both the from and to dates.");
        return;
    }
    if (start > end) {
        setMessage("budgetPeriodMessage", "The from date must be on or before the to date.");
        return;
    }
    budgetStartDate = start;
    budgetEndDate = end;
    clearMessage("budgetPeriodMessage");
    refreshAll();
    scheduleBudgetRollover();
}
$("budgetStartDateInput")?.addEventListener("change", saveBudgetPeriodDates);
$("budgetEndDateInput")?.addEventListener("change", saveBudgetPeriodDates);
$("budgetCycleMode")?.addEventListener("change", async () => {
    const selectedMode = $("budgetCycleMode").value;
    if (selectedMode !== "30days" && selectedMode !== "monthEnd") return;
    budgetCycleMode = selectedMode;
    if (activeUser) {
        localStorage.setItem(`monetaTribeCycleMode_${activeUser.id}`, budgetCycleMode);
        const { data, error } = await supabaseClient.auth.updateUser({ data: { ...(activeUser.user_metadata || {}), monetatribe_budget_cycle_mode: budgetCycleMode } });
        if (error) setMessage("budgetPeriodMessage", "The next-period preference could not be synced to your account.");
        else activeUser = data.user;
    }
});

$("addEnvelopeButton")?.addEventListener("click", () => {
    renderAddEnvelopeSummary();
    clearMessage("addEnvelopeMessage");
    $("addEnvelopeForm")?.reset();
    renderPocketIconPicker("addPocketIconPicker", "envelopeIcon", "general");
    showPage("addEnvelopePage");
});

function submitEnvelope(addAnother = false) {
    const name = $("envelopeName")?.value.trim();
    const budget = Number($("envelopeBudget")?.value);
    const iconKey = normalizePocketIconKey($("envelopeIcon")?.value, name);
    if (!name) return setMessage("addEnvelopeMessage", "Enter a pocket name.");
    if (envelopes.some(e => e.name.toLowerCase() === name.toLowerCase())) return setMessage("addEnvelopeMessage", "A pocket with this name already exists.");
    if (!Number.isFinite(budget) || budget <= 0) return setMessage("addEnvelopeMessage", "Enter a budget greater than zero.");
    if (totalBudget() + budget > monthlyIncome) return setMessage("addEnvelopeMessage", "This exceeds your unallocated monthly income.");
    envelopes.push({ name, budget, spent: 0, iconKey });
    refreshAll();
    if (addAnother) {
        $("addEnvelopeForm")?.reset();
        renderPocketIconPicker("addPocketIconPicker", "envelopeIcon", "general");
        renderAddEnvelopeSummary();
        setMessage("addEnvelopeMessage", "Pocket saved. You can add another.", false);
    } else {
        showPage("setupPage");
    }
}
$("addEnvelopeForm")?.addEventListener("submit", event => { event.preventDefault(); submitEnvelope(false); });
$("addAnotherEnvelope")?.addEventListener("click", () => submitEnvelope(true));

function calculateTransactionExpression(expression) {
    const source = expression.replace(/×/g, "*").replace(/÷/g, "/");
    let position = 0;
    const skipSpaces = () => { while (source[position] === " ") position++; };
    const parseNumber = () => {
        skipSpaces();
        let sign = 1;
        if (source[position] === "+" || source[position] === "-") {
            if (source[position] === "-") sign = -1;
            position++;
            skipSpaces();
        }
        const match = source.slice(position).match(/^(?:\d+(?:\.\d*)?|\.\d+)/);
        if (!match) throw new Error("Enter a number first.");
        position += match[0].length;
        return sign * Number(match[0]);
    };
    const parseProduct = () => {
        let value = parseNumber();
        while (true) {
            skipSpaces();
            const operator = source[position];
            if (operator !== "*" && operator !== "/") return value;
            position++;
            const next = parseNumber();
            if (operator === "/" && next === 0) throw new Error("Cannot divide by zero.");
            value = operator === "*" ? value * next : value / next;
        }
    };
    const parseSum = () => {
        let value = parseProduct();
        while (true) {
            skipSpaces();
            const operator = source[position];
            if (operator !== "+" && operator !== "-") return value;
            position++;
            const next = parseProduct();
            value = operator === "+" ? value + next : value - next;
        }
    };
    if (!source.trim()) throw new Error("Enter a calculation first.");
    const result = parseSum();
    skipSpaces();
    if (position !== source.length || !Number.isFinite(result)) throw new Error("Check the calculation and try again.");
    return Number(result.toFixed(2));
}

let calculatorExpression = "";
let calculatorJustEvaluated = false;

function renderTransactionCalculator() {
    calculatorExpression = $("transactionAmount")?.value || "";
}

function openTransactionCalculator() {
    const panel = $("transactionCalculator");
    if (!panel) return;
    calculatorExpression = $("transactionAmount")?.value || "";
    panel.hidden = false;
    $("transactionAmount")?.setAttribute("aria-expanded", "true");
}

function closeTransactionCalculator() {
    const panel = $("transactionCalculator");
    if (panel) panel.hidden = true;
    $("transactionAmount")?.setAttribute("aria-expanded", "false");
}

function evaluateTransactionCalculator() {
    try {
        const result = calculateTransactionExpression(calculatorExpression);
        calculatorExpression = String(result);
        $("transactionAmount").value = calculatorExpression;
        calculatorJustEvaluated = true;
        renderTransactionCalculator();
        clearMessage("transactionCalculatorMessage");
        return result;
    } catch (error) {
        setMessage("transactionCalculatorMessage", error.message);
        return null;
    }
}

function enterCalculatedAmount() {
    const amount = evaluateTransactionCalculator();
    if (amount === null) return false;
    if (amount <= 0) {
        setMessage("transactionCalculatorMessage", "The transaction amount must be greater than zero.");
        return false;
    }
    $("transactionAmount").value = String(amount);
    calculatorExpression = String(amount);
    calculatorJustEvaluated = true;
    closeTransactionCalculator();
    $("transactionEnvelope")?.focus();
    return true;
}

async function saveTransaction(addAnother = false) {
    const envelope = findEnvelope($("transactionEnvelope")?.value);
    const amountText = $("transactionAmount")?.value.trim() || "";
    let amount = Number(amountText);
    if (!Number.isFinite(amount) && amountText) {
        try { amount = calculateTransactionExpression(amountText); }
        catch { return setMessage("transactionMessage", "Enter a valid amount or calculation."); }
    }
    const description = $("transactionDescription")?.value.trim();
    const date = $("transactionDate")?.value;
    if (!envelope) return setMessage("transactionMessage", "Choose a pocket.");
    if (!Number.isFinite(amount) || amount <= 0) return setMessage("transactionMessage", "Enter an amount greater than zero.");
    if (!description) return setMessage("transactionMessage", "Enter a description.");
    if (!date) return setMessage("transactionMessage", "Choose a date.");
    $("transactionAmount").value = String(amount);
    closeTransactionCalculator();
    const keepEnvelope = envelope.name;
    const keepDate = date;
    let transactionId = Date.now();
    if (isRestrictedFamilyMember()) {
        if (!cloudBudgetId || !envelope.dbId) return setMessage("transactionMessage", "The shared budget is still loading. Please try again shortly.");
        const submitButtons = [$('transactionForm')?.querySelector('button[type="submit"]'), $("saveAndAddNewTransaction")].filter(Boolean);
        submitButtons.forEach(button => { button.disabled = true; });
        setMessage("transactionMessage", "Saving transaction…", false);
        const { data, error } = await supabaseClient.from("transactions").insert({
            user_id: activeUser.id,
            budget_id: cloudBudgetId,
            envelope_id: envelope.dbId,
            transaction_type: "expense",
            transaction_date: date,
            description,
            amount
        }).select("id").single();
        submitButtons.forEach(button => { button.disabled = false; });
        if (error) return setMessage("transactionMessage", `Transaction could not be saved: ${error.message}`);
        transactionId = data.id;
    }
    envelope.spent += amount;
    transactions.push({ id: transactionId, userId: activeUser?.id, type: "expense", envelope: envelope.name, amount, description, date });
    refreshAll({ persist: !isRestrictedFamilyMember() });
    if (isRestrictedFamilyMember()) rememberCurrentBudgetProfile();
    $("transactionForm").reset();
    renderTransactionForm();
    if (addAnother) {
        $("transactionEnvelope").value = keepEnvelope;
        $("transactionDate").value = keepDate;
        setMessage("transactionMessage", "Transaction saved. Enter the next one.", false);
        showPage("transactionPage");
        $("transactionAmount").focus();
    } else {
        clearMessage("transactionMessage");
        showPage("homePage");
    }
}

$("transactionForm")?.addEventListener("submit", event => {
    event.preventDefault();
    saveTransaction(false);
});
$("saveAndAddNewTransaction")?.addEventListener("click", () => saveTransaction(true));
$("transactionAmount")?.addEventListener("focus", () => {
    if (!calculatorJustEvaluated) openTransactionCalculator();
});
$("transactionAmount")?.addEventListener("click", openTransactionCalculator);
$("transactionAmount")?.addEventListener("input", event => {
    calculatorExpression = event.currentTarget.value;
    calculatorJustEvaluated = false;
    renderTransactionCalculator();
});
$("transactionAmount")?.addEventListener("keydown", event => {
    if (event.key === "Escape") {
        event.preventDefault();
        closeTransactionCalculator();
    }
});
$("transactionCalculator")?.addEventListener("click", event => {
    const button = event.target.closest("button[data-calculator-key], button[data-calculator-action]");
    if (!button) return;
    const action = button.dataset.calculatorAction;
    if (action === "clear") {
        calculatorExpression = "";
        $("transactionAmount").value = "";
        calculatorJustEvaluated = false;
        clearMessage("transactionCalculatorMessage");
        renderTransactionCalculator();
        return;
    }
    if (action === "backspace") {
        calculatorExpression = calculatorJustEvaluated ? "" : calculatorExpression.slice(0, -1);
        $("transactionAmount").value = calculatorExpression;
        calculatorJustEvaluated = false;
        clearMessage("transactionCalculatorMessage");
        renderTransactionCalculator();
        return;
    }
    if (action === "calculate") {
        evaluateTransactionCalculator();
        return;
    }
    const key = button.dataset.calculatorKey;
    if (!key || calculatorExpression.length >= 64) return;
    const operator = ["+", "-", "*", "/"].includes(key);
    if (calculatorJustEvaluated && !operator) calculatorExpression = "";
    calculatorJustEvaluated = false;
    calculatorExpression += key;
    $("transactionAmount").value = calculatorExpression;
    clearMessage("transactionCalculatorMessage");
    renderTransactionCalculator();
});
$("useCalculatedAmount")?.addEventListener("click", enterCalculatedAmount);
document.addEventListener("keydown", event => {
    const calculator = $("transactionCalculator");
    if (event.key !== "Enter" || !calculator || calculator.hidden) return;
    event.preventDefault();
    event.stopImmediatePropagation();
    enterCalculatedAmount();
}, true);
document.addEventListener("click", event => {
    const calculator = $("transactionCalculator");
    if (!calculator || calculator.hidden) return;
    if (event.target.closest("#transactionAmount, #transactionCalculator")) return;
    closeTransactionCalculator();
});

$("editEnvelopeForm")?.addEventListener("submit", event => {
    event.preventDefault();
    saveEnvelopeEdits();
});
$("deleteEnvelopeButton")?.addEventListener("click", () => {
    if (editingEnvelopeName) deleteEnvelope(editingEnvelopeName);
});
$("cancelEditEnvelope")?.addEventListener("click", () => { renderSetup(); showPage("setupPage"); });

$("transferFrom")?.addEventListener("change", updateSourceBalance);
$("transferForm")?.addEventListener("submit", event => {
    event.preventDefault();
    const source = findEnvelope($("transferFrom")?.value);
    const destination = findEnvelope($("transferTo")?.value);
    const amount = Number($("transferAmount")?.value);
    if (!source || !destination) return setMessage("transferMessage", "Select both pockets.");
    if (source === destination) return setMessage("transferMessage", "Choose two different pockets.");
    if (!Number.isFinite(amount) || amount <= 0) return setMessage("transferMessage", "Enter an amount greater than zero.");
    if (amount > source.budget - source.spent) return setMessage("transferMessage", "The source pocket does not have enough unspent budget.");
    source.budget -= amount;
    destination.budget += amount;
    transactions.push({ id: Date.now(), userId: activeUser?.id, type: "transfer", source: source.name, destination: destination.name, amount, description: `Transfer from ${source.name} to ${destination.name}`, date: new Date().toISOString().slice(0, 10) });
    refreshAll();
    $("transferForm").reset();
    renderTransferForm();
    showPage("homePage");
});


$("historyBackToHome")?.addEventListener("click", () => {
    historyManageMode = false;
    historyViewingArchive = false;
    historyPocketFilter = null;
    archivedTransactions = [];
    archivedBudgetIds = [];
    archiveManageMode = false;
    clearMessage("historyArchiveMessage");
    if ($("editTransactionForm")) $("editTransactionForm").hidden = true;
    renderDashboard();
    showPage("homePage");
});

$("clearHistoryPocketFilter")?.addEventListener("click", () => {
    historyPocketFilter = null;
    renderHistory();
});

$("toggleHistoryManagement")?.addEventListener("click", () => {
    if (historyViewingArchive) return;
    historyManageMode = !historyManageMode;
    if (!historyManageMode) $("editTransactionForm").hidden = true;
    renderHistory();
});
$("togglePreviousTransactions")?.addEventListener("click", () => {
    togglePreviousBudgetTransactions().catch(error => {
        console.error("Could not load previous budget transactions:", error);
        setText("historyArchiveMessage", "Previous budget transactions could not be loaded. Please try again.");
    });
});
$("deleteAllPreviousTransactions")?.addEventListener("click", () => {
    deleteAllPreviousTransactions();
});
$("togglePreviousTransactionsManagement")?.addEventListener("click", () => {
    if (!historyViewingArchive) return;
    archiveManageMode = !archiveManageMode;
    renderHistory();
});
$("previousTransactionsFrom")?.addEventListener("change", renderHistory);
$("previousTransactionsTo")?.addEventListener("change", renderHistory);
$("clearPreviousTransactionDates")?.addEventListener("click", () => {
    $("previousTransactionsFrom").value = "";
    $("previousTransactionsTo").value = "";
    renderHistory();
});
$("editTransactionForm")?.addEventListener("submit", saveEditedTransaction);
$("cancelEditTransaction")?.addEventListener("click", () => { $("editTransactionForm").hidden = true; clearMessage("editTransactionMessage"); });

$("deleteTransactionsPeriod")?.addEventListener("click", deleteTransactionsByPeriod);
$("deleteAllTransactions")?.addEventListener("click", deleteAllTransactions);

// Restore a normal session, but never route a password-recovery session to the dashboard.
refreshAll();
showPage("sessionLoadingPage");
supabaseClient.auth.getSession().then(async ({ data, error }) => {
    if (error || !data.session) {
        if (passwordRecoveryActive) showNewPasswordForm();
        else {
            if (error) setMessage("message", "Your session could not be restored. Please log in.");
            showPage("loginPage");
        }
        return;
    }

    activeUser = data.session.user;
    if (passwordRecoveryActive) {
        showNewPasswordForm();
        return;
    }

    if (localStorage.getItem(KEEP_LOGGED_IN_KEY) !== "yes") {
        await supabaseClient.auth.signOut();
        budgetProfileCache.clear();
        familyMembersCache.clear();
        familyMembersLoading.clear();
        familyMembersPromises.clear();
        familyMembershipLoadedUserId = null;
        activeUser = null;
        activeFamily = null;
        activeFamilyRole = null;
        activeFamilyRestricted = false;
        budgetProfileMode = "personal";
        cloudBudgetId = null;
        showPage("loginPage");
        return;
    }

    try {
        await loadCloudData();
        showPage("homePage");
    } catch (err) {
        console.error("Could not restore cloud data:", err);
        alert("You are signed in, but your cloud data could not be loaded: " + err.message);
    }
}).catch(error => {
    console.error("Could not check the saved session:", error);
    setMessage("message", "Your session could not be checked. Please log in.");
    showPage("loginPage");
});
