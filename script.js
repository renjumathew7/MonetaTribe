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
let budgetProfileMode = "personal";
let familySchemaAvailable = true;
let passwordRecoveryActive = window.location.hash.includes("type=recovery");
let cloudBudgetId = null;
let cloudSaveTimer = null;
let cloudSaveInFlight = Promise.resolve();
let isDemoBudget = false;
let budgetStartDate = "";
let budgetEndDate = "";
let budgetCycleMode = "30days";
let previousEnvelopeBudgets = {};
let historyViewingArchive = false;
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
    return error?.code === "PGRST205" || /family_members.*schema cache|could not find the table ['"]?public\.family_members/i.test(error?.message || "");
}
function familySetupRequiredMessage() {
    return "Family features are not enabled yet. Run supabase-family-migration.sql in the Supabase Dashboard SQL Editor, then reload the app.";
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
    if (!activeUser || !budgetEndDate) return;
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

let envelopes = defaultEnvelopes.map(e => ({ ...e }));
let transactions = [];
let monthlyIncome = 40000;
let historyManageMode = false;

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
            .map(e => ({ name: e.name, budget: Number(e.budget) || 0, spent: Number(e.spent) || 0 }));
        transactions = transactions.filter(t => t && typeof t === "object");
    } catch (error) {
        console.error("Unable to load saved Moneta Tribe data:", error);
    }
}

function saveAppData() {
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

async function loadCloudData() {
    if (!activeUser) return;
    loadBudgetCycleMode();
    const savedMode = localStorage.getItem(`monetaTribeBudgetProfile_${activeUser.id}`);
    budgetProfileMode = savedMode === "family" ? "family" : "personal";
    const { data: memberships, error: membershipError } = await supabaseClient.from("family_members")
        .select("family_id,families(id,name,invite_code)").eq("user_id", activeUser.id).limit(1);
    familySchemaAvailable = !membershipError;
    if (membershipError && !isFamilySchemaMissingError(membershipError)) throw membershipError;
    if (!familySchemaAvailable) {
        activeFamily = null;
        budgetProfileMode = "personal";
    } else {
        const familyRelation = memberships?.[0]?.families;
        activeFamily = Array.isArray(familyRelation) ? (familyRelation[0] || null) : (familyRelation || null);
    }
    if (!activeFamily) budgetProfileMode = "personal";
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
            refreshAll();
        } else {
            envelopes = []; transactions = []; monthlyIncome = 0; isDemoBudget = false;
            refreshAll();
        }
        scheduleBudgetRollover();
        return;
    }
    isDemoBudget = false;
    monthlyIncome = Number(budget.monthly_income) || 0;
    budgetStartDate = budget.start_date;
    budgetEndDate = budget.end_date;
    const { data: dbEnvelopes, error: envError } = await supabaseClient.from("envelopes").select("*").eq("budget_id", budget.id).order("created_at");
    if (envError) throw envError;
    const { data: dbTransactions, error: txError } = await supabaseClient.from("transactions").select("*").eq("budget_id", budget.id).order("transaction_date", { ascending: false });
    if (txError) throw txError;
    const byId = new Map((dbEnvelopes || []).map(e => [e.id, e]));
    transactions = (dbTransactions || []).map(t => ({
        id: t.id, type: t.transaction_type, date: t.transaction_date, amount: Number(t.amount), description: t.description || "",
        envelope: byId.get(t.envelope_id)?.name || "", source: t.transaction_type === "transfer" ? byId.get(t.envelope_id)?.name : undefined,
        destination: t.transfer_to_envelope_id ? byId.get(t.transfer_to_envelope_id)?.name : undefined
    }));
    envelopes = (dbEnvelopes || []).map(e => ({ name: e.name, budget: Number(e.allocated_budget) || 0, spent: 0 }));
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
    refreshAll();
    scheduleBudgetRollover();
}

function saveCloudData() {
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
    if (!activeUser) return;
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
    if (!saveEnvelopes.length) return;
    // Replace the saved rows as one logical snapshot under this account's persistent budget.
    const { error: deleteTxError } = await supabaseClient.from("transactions").delete().eq("budget_id", cloudBudgetId);
    if (deleteTxError) throw deleteTxError;
    const { error: deleteEnvError } = await supabaseClient.from("envelopes").delete().eq("budget_id", cloudBudgetId);
    if (deleteEnvError) throw deleteEnvError;
    const rows = saveEnvelopes.map(e => ({ user_id: saveUserId, budget_id: budget.id, name: e.name, allocated_budget: e.budget }));
    const { data: savedEnvelopes, error: insertEnvError } = await supabaseClient.from("envelopes").insert(rows).select("id,name");
    if (insertEnvError) throw insertEnvError;
    const ids = new Map(savedEnvelopes.map(e => [e.name, e.id]));
    const txRows = saveTransactions.map(t => {
        const transfer = t.type === "transfer";
        const sourceName = transfer ? t.source : t.envelope;
        return { user_id: saveUserId, budget_id: budget.id, envelope_id: ids.get(sourceName),
            transfer_to_envelope_id: transfer ? ids.get(t.destination) : null, transaction_type: transfer ? "transfer" : "expense",
            transaction_date: t.date, description: t.description || "", amount: t.amount };
    }).filter(t => t.envelope_id);
    if (txRows.length) { const { error } = await supabaseClient.from("transactions").insert(txRows); if (error) throw error; }
}
loadAppData();

function money(value) {
    return new Intl.NumberFormat("en-IN", { style: "currency", currency: "INR", maximumFractionDigits: 0 }).format(Number(value) || 0);
}
function totalBudget() { return envelopes.reduce((sum, e) => sum + e.budget, 0); }
function totalSpent() { return envelopes.reduce((sum, e) => sum + e.spent, 0); }
function availableIncome() { return monthlyIncome - totalBudget(); }
function actualBalance() { return monthlyIncome - totalSpent(); }
function findEnvelope(name) { return envelopes.find(e => e.name === name); }
function setText(id, value) { const el = $(id); if (el) el.textContent = value; }
function showPage(id) {
    pageIds.forEach(pageId => { const el = $(pageId); if (el) el.hidden = pageId !== id; });
    window.scrollTo({ top: 0, behavior: "auto" });
}
function setMessage(id, message, isError = true) {
    const el = $(id);
    if (!el) return;
    el.textContent = message;
    el.style.color = isError ? "#b42318" : "#176b55";
}
function clearMessage(id) { setMessage(id, "", false); }

function refreshAll() {
    renderDashboard();
    renderSetup();
    renderAddEnvelopeSummary();
    renderTransactionForm();
    renderHistory();
    renderTransferForm();
    saveAppData();
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
    if (personalButton) personalButton.setAttribute("aria-pressed", String(budgetProfileMode !== "family"));
    if (familyButton) {
        familyButton.setAttribute("aria-pressed", String(budgetProfileMode === "family"));
        familyButton.textContent = activeFamily ? activeFamily.name : "Family";
        familyButton.title = activeFamily?.name || "Family budget";
    }
    setText("totalSpent", money(totalSpent()));
    setText("actualBalance", money(actualBalance()));
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
        const top = document.createElement("div");
        top.className = "envelope-top";
        const title = document.createElement("h3");
        title.textContent = envelope.name;
        const balance = document.createElement("p");
        balance.className = overspent ? "envelope-balance envelope-negative-balance" : "envelope-balance";
        balance.textContent = money(envelope.budget - envelope.spent);
        top.append(title, balance);
        const progress = document.createElement("div");
        progress.className = overspent ? "progress-track progress-over-budget" : "progress-track";
        const fill = document.createElement("div");
        fill.className = overspent ? "progress-fill progress-over-budget-fill" : "progress-fill";
        const progressPercent = overspent
            ? (envelope.budget > 0 ? ((envelope.spent - envelope.budget) / envelope.budget) * 100 : 100)
            : (envelope.budget > 0 ? ((envelope.budget - envelope.spent) / envelope.budget) * 100 : 0);
        fill.style.width = `${Math.max(0, Math.min(100, progressPercent))}%`;
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

function renderProfile() {
    const metadata = activeUser?.user_metadata || {};
    const fullName = getProfileFullName();
    setText("profileName", fullName || "Not provided");
    setText("profileEmail", activeUser?.email || "Not available");
    setText("profilePhone", activeUser?.phone || metadata.phone || metadata.phone_number || "Not provided");
    setText("profileAge", metadata.age ? `${metadata.age} years` : "Not provided");
    setText("profileGender", metadata.gender ? (String(metadata.gender).charAt(0).toUpperCase() + String(metadata.gender).slice(1)) : "Not provided");
    const createdAt = activeUser?.created_at ? new Date(activeUser.created_at) : null;
    const createdAtText = createdAt && !Number.isNaN(createdAt.getTime())
        ? new Intl.DateTimeFormat("en-IN", { dateStyle: "long" }).format(createdAt)
        : "Not available";
    setText("profileCreatedAt", createdAtText);
    const hasFamily = Boolean(activeFamily);
    $("familyForms").hidden = hasFamily || !familySchemaAvailable;
    $("familyDetails").hidden = !hasFamily;
    setText("familyProfileStatus", !familySchemaAvailable
        ? familySetupRequiredMessage()
        : hasFamily
            ? "Your family shares a separate budget profile. Switch profiles from the dashboard header."
            : "Create a family budget or join one with a member’s six digit code.");
    if (hasFamily) {
        setText("familyNameDisplay", activeFamily.name);
        setText("familyCodeDisplay", activeFamily.invite_code);
    }
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
        row.className = "setup-envelope-item";
        const details = document.createElement("span");
        details.textContent = `${envelope.name} — ${money(envelope.budget)} budget · ${money(envelope.spent)} spent`;
        row.append(details, makeEnvelopeActions(envelope.name));
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
    if (!newName) return setMessage("editEnvelopeMessage", "Enter a pocket name.");
    if (envelopes.some(e => e !== envelope && e.name.toLowerCase() === newName.toLowerCase())) return setMessage("editEnvelopeMessage", "A pocket with this name already exists.");
    if (!Number.isFinite(newBudget) || newBudget < 0) return setMessage("editEnvelopeMessage", "Budget must be zero or greater.");
    if (totalBudget() - envelope.budget + newBudget > monthlyIncome) return setMessage("editEnvelopeMessage", "Total budgets cannot exceed monthly income.");
    const oldName = envelope.name;
    envelope.name = newName;
    envelope.budget = newBudget;
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
    list.replaceChildren();
    const archiveFrom = $("previousTransactionsFrom")?.value || "";
    const archiveTo = $("previousTransactionsTo")?.value || "";
    const invalidArchiveRange = historyViewingArchive && archiveFrom && archiveTo && archiveFrom > archiveTo;
    const archivedMatches = archivedTransactions.filter(t => (!archiveFrom || String(t.date || "") >= archiveFrom) && (!archiveTo || String(t.date || "") <= archiveTo));
    const shownTransactions = historyViewingArchive ? archivedMatches : transactions;
    setText("historyCount", `${shownTransactions.length} ${shownTransactions.length === 1 ? "transaction" : "transactions"}${historyViewingArchive ? " in previous budgets" : ""}`);
    setText("historyEmptyMessage", invalidArchiveRange ? "From date must be on or before To date." : shownTransactions.length ? "" : (historyViewingArchive ? (archivedTransactions.length ? "No previous transactions match these dates." : "No previous transactions have been recorded.") : "No transactions recorded yet."));
    const toggle = $("toggleHistoryManagement");
    if (toggle) toggle.textContent = historyManageMode ? "Done" : "Edit Transactions";
    if (toggle) toggle.hidden = historyViewingArchive;
    const previousToggle = $("togglePreviousTransactions");
    if (previousToggle) previousToggle.textContent = historyViewingArchive ? "View Current Transactions" : "Previous Transactions";
    const archiveFilters = $("previousTransactionsFilters");
    if (archiveFilters) archiveFilters.hidden = !historyViewingArchive;
    const archiveActions = $("previousTransactionsActions");
    if (archiveActions) archiveActions.hidden = !historyViewingArchive;
    const archiveManageToggle = $("togglePreviousTransactionsManagement");
    if (archiveManageToggle) archiveManageToggle.textContent = archiveManageMode ? "Done Editing Previous Transactions" : "Edit Previous Transactions";
    const deleteAllArchiveButton = $("deleteAllPreviousTransactions");
    if (deleteAllArchiveButton) deleteAllArchiveButton.hidden = !archiveManageMode || archivedTransactions.length === 0;
    const panel = $("historyManagementPanel");
    if (panel) panel.hidden = !historyManageMode || historyViewingArchive;
    const editForm = $("editTransactionForm");
    if (historyViewingArchive && editForm) editForm.hidden = true;
    [...shownTransactions].sort((a, b) => String(b.date || "").localeCompare(String(a.date || ""))).forEach(t => {
        const row = document.createElement("div");
        row.className = "transaction-item";
        const details = document.createElement("div"); details.className = "transaction-main-details";
        const desc = document.createElement("strong"); desc.textContent = t.description || (t.type === "transfer" ? "Budget transfer" : "Expense");
        const category = document.createElement("span"); category.textContent = t.type === "transfer" ? `${t.source} → ${t.destination}` : (t.envelope || "—");
        const date = document.createElement("span"); date.className = "transaction-date"; date.textContent = t.date || "";
        details.append(desc, category, date);
        const amount = document.createElement("strong"); amount.className = "transaction-amount"; amount.textContent = money(t.amount);
        row.append(details, amount);
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
        id: t.id, budgetId: t.budget_id, type: t.transaction_type, date: t.transaction_date, amount: Number(t.amount), description: t.description || "",
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
    const id = Number($("editTransactionId").value);
    const old = transactions.find(t => t.id === id);
    if (!old || old.type === "transfer") return;
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
    activeUser = null;
    activeFamily = null;
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
    activeUser = null; activeFamily = null; budgetProfileMode = "personal"; cloudBudgetId = null; historyViewingArchive = false; archivedTransactions = []; archivedBudgetIds = []; archiveManageMode = false; showPage("loginPage");
});
$("backToHome")?.addEventListener("click", () => { renderDashboard(); showPage("homePage"); });
$("viewProfileButton")?.addEventListener("click", () => { renderProfile(); showPage("profilePage"); });
$("profileBackToHome")?.addEventListener("click", () => showPage("homePage"));
async function switchBudgetProfile(mode) {
    if (mode === "family" && !activeFamily) return;
    if (budgetProfileMode === mode) return;
    try { await flushPendingCloudSave(); }
    catch (error) {
        alert("The current budget could not be saved, so the profile was not switched: " + error.message);
        return;
    }
    budgetProfileMode = mode;
    historyViewingArchive = false;
    archivedTransactions = [];
    archivedBudgetIds = [];
    archiveManageMode = false;
    if (activeUser) localStorage.setItem(`monetaTribeBudgetProfile_${activeUser.id}`, mode);
    try {
        await loadCloudData();
        await flushPendingCloudSave();
        showPage("homePage");
    } catch (error) {
        console.error("Could not switch budget profile:", error);
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
    budgetProfileMode = "family";
    localStorage.setItem(`monetaTribeBudgetProfile_${activeUser.id}`, "family");
    try { await loadCloudData(); await flushPendingCloudSave(); }
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
    budgetProfileMode = "family";
    localStorage.setItem(`monetaTribeBudgetProfile_${activeUser.id}`, "family");
    try { await loadCloudData(); await flushPendingCloudSave(); showPage("homePage"); }
    catch (err) { setMessage("joinFamilyMessage", "You joined the family, but its shared budget could not load: " + err.message); }
});
$("editProfileButton")?.addEventListener("click", () => {
    const metadata = activeUser?.user_metadata || {};
    $("editProfileName").value = getProfileFullName();
    $("editProfileAge").value = metadata.age || "";
    $("editProfileGender").value = metadata.gender || "";
    $("editProfileForm").hidden = false;
    $("editProfileButton").hidden = true;
    clearMessage("editProfileMessage");
});
$("cancelEditProfile")?.addEventListener("click", () => {
    $("editProfileForm").hidden = true;
    $("editProfileButton").hidden = false;
    clearMessage("editProfileMessage");
});
$("editProfileForm")?.addEventListener("submit", async event => {
    event.preventDefault();
    const fullName = $("editProfileName").value.trim();
    const age = Number($("editProfileAge").value);
    const gender = $("editProfileGender").value;
    if (!fullName) return setMessage("editProfileMessage", "Enter your full name.");
    if (!Number.isInteger(age) || age < 13 || age > 120) return setMessage("editProfileMessage", "Enter an age from 13 to 120.");
    if (gender !== "male" && gender !== "female") return setMessage("editProfileMessage", "Select a gender.");
    const submitButton = $("editProfileForm").querySelector('button[type="submit"]');
    submitButton.disabled = true;
    setMessage("editProfileMessage", "Saving profile…", false);
    const metadata = activeUser?.user_metadata || {};
    const { data, error } = await supabaseClient.auth.updateUser({
        data: { ...metadata, full_name: fullName, age, gender }
    });
    submitButton.disabled = false;
    if (error) return setMessage("editProfileMessage", error.message);
    activeUser = data.user;
    $("editProfileForm").hidden = true;
    $("editProfileButton").hidden = false;
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
        if (target === "historyPage") renderHistory();
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
        const { data, error } = await supabaseClient.auth.updateUser({ data: { monetatribe_budget_cycle_mode: budgetCycleMode } });
        if (error) setMessage("budgetPeriodMessage", "The next-period preference could not be synced to your account.");
        else activeUser = data.user;
    }
});

$("addEnvelopeButton")?.addEventListener("click", () => {
    renderAddEnvelopeSummary();
    clearMessage("addEnvelopeMessage");
    $("addEnvelopeForm")?.reset();
    showPage("addEnvelopePage");
});

function submitEnvelope(addAnother = false) {
    const name = $("envelopeName")?.value.trim();
    const budget = Number($("envelopeBudget")?.value);
    if (!name) return setMessage("addEnvelopeMessage", "Enter a pocket name.");
    if (envelopes.some(e => e.name.toLowerCase() === name.toLowerCase())) return setMessage("addEnvelopeMessage", "A pocket with this name already exists.");
    if (!Number.isFinite(budget) || budget <= 0) return setMessage("addEnvelopeMessage", "Enter a budget greater than zero.");
    if (totalBudget() + budget > monthlyIncome) return setMessage("addEnvelopeMessage", "This exceeds your unallocated monthly income.");
    envelopes.push({ name, budget, spent: 0 });
    refreshAll();
    if (addAnother) {
        $("addEnvelopeForm")?.reset();
        renderAddEnvelopeSummary();
        setMessage("addEnvelopeMessage", "Pocket saved. You can add another.", false);
    } else {
        showPage("setupPage");
    }
}
$("addEnvelopeForm")?.addEventListener("submit", event => { event.preventDefault(); submitEnvelope(false); });
$("addAnotherEnvelope")?.addEventListener("click", () => submitEnvelope(true));

function saveTransaction(addAnother = false) {
    const envelope = findEnvelope($("transactionEnvelope")?.value);
    const amount = Number($("transactionAmount")?.value);
    const description = $("transactionDescription")?.value.trim();
    const date = $("transactionDate")?.value;
    if (!envelope) return setMessage("transactionMessage", "Choose a pocket.");
    if (!Number.isFinite(amount) || amount <= 0) return setMessage("transactionMessage", "Enter an amount greater than zero.");
    if (!description) return setMessage("transactionMessage", "Enter a description.");
    if (!date) return setMessage("transactionMessage", "Choose a date.");
    const keepEnvelope = envelope.name;
    const keepDate = date;
    envelope.spent += amount;
    transactions.push({ id: Date.now(), type: "expense", envelope: envelope.name, amount, description, date });
    refreshAll();
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
    transactions.push({ id: Date.now(), type: "transfer", source: source.name, destination: destination.name, amount, description: `Transfer from ${source.name} to ${destination.name}`, date: new Date().toISOString().slice(0, 10) });
    refreshAll();
    $("transferForm").reset();
    renderTransferForm();
    showPage("homePage");
});


$("historyBackToHome")?.addEventListener("click", () => {
    historyManageMode = false;
    historyViewingArchive = false;
    archivedTransactions = [];
    archivedBudgetIds = [];
    archiveManageMode = false;
    clearMessage("historyArchiveMessage");
    if ($("editTransactionForm")) $("editTransactionForm").hidden = true;
    renderDashboard();
    showPage("homePage");
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
        activeUser = null;
        activeFamily = null;
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
