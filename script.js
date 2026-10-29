"use strict";

const STORAGE_KEY = "monetaTribeData";

// Pages and elements use the IDs from index.html.
const pageIds = ["loginPage", "createAccountPage", "homePage", "setupPage", "editEnvelopePage", "addEnvelopePage", "transactionPage", "historyPage", "transferPage"];
const $ = id => document.getElementById(id);

const supabaseClient = window.supabase.createClient(
    window.MONETATRIBE_SUPABASE_URL,
    window.MONETATRIBE_SUPABASE_PUBLISHABLE_KEY
);
let activeUser = null;
let cloudBudgetId = null;
let cloudSaveTimer = null;
function currentPeriod() {
    const now = new Date();
    const start = new Date(now.getFullYear(), now.getMonth(), 1);
    const end = new Date(now.getFullYear(), now.getMonth() + 1, 0);
    const iso = d => `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,"0")}-${String(d.getDate()).padStart(2,"0")}`;
    return { startDate: iso(start), endDate: iso(end) };
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
        envelopes = envelopes.filter(e => e && typeof e.name === "string")
            .map(e => ({ name: e.name, budget: Number(e.budget) || 0, spent: Number(e.spent) || 0 }));
        transactions = transactions.filter(t => t && typeof t === "object");
    } catch (error) {
        console.error("Unable to load saved Moneta Tribe data:", error);
    }
}

function saveAppData() {
    try {
        localStorage.setItem(STORAGE_KEY, JSON.stringify({ envelopes, transactions, monthlyIncome }));
    } catch (error) {
        console.error("Unable to save MonetaTribe data locally:", error);
    }
    if (activeUser) {
        clearTimeout(cloudSaveTimer);
        cloudSaveTimer = setTimeout(() => saveCloudData().catch(error => {
            console.error("Supabase save failed:", error);
            alert("Cloud save failed. Please check your connection and Supabase table policies before continuing.");
        }), 700);
    }
}

async function loadCloudData() {
    if (!activeUser) return;
    const period = currentPeriod();
    const { data: budget, error: budgetError } = await supabaseClient
        .from("monthly_budgets").select("*").eq("user_id", activeUser.id).eq("start_date", period.startDate).maybeSingle();
    if (budgetError) throw budgetError;
    cloudBudgetId = budget?.id || null;
    if (!budget) {
        envelopes = []; transactions = []; monthlyIncome = 0;
        refreshAll();
        return;
    }
    monthlyIncome = Number(budget.monthly_income) || 0;
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
    refreshAll();
}

async function saveCloudData() {
    if (!activeUser) return;
    const period = currentPeriod();
    const budgetPayload = { user_id: activeUser.id, monthly_income: monthlyIncome, start_date: period.startDate, end_date: period.endDate };
    const { data: budget, error: budgetError } = await supabaseClient.from("monthly_budgets")
        .upsert(budgetPayload, { onConflict: "user_id,start_date" }).select("id").single();
    if (budgetError) throw budgetError;
    cloudBudgetId = budget.id;
    // Replace this month's rows as one logical snapshot, preserving the current app's simple data model.
    const { error: deleteTxError } = await supabaseClient.from("transactions").delete().eq("budget_id", cloudBudgetId);
    if (deleteTxError) throw deleteTxError;
    const { error: deleteEnvError } = await supabaseClient.from("envelopes").delete().eq("budget_id", cloudBudgetId);
    if (deleteEnvError) throw deleteEnvError;
    if (!envelopes.length) return;
    const rows = envelopes.map(e => ({ user_id: activeUser.id, budget_id: cloudBudgetId, name: e.name, allocated_budget: e.budget }));
    const { data: savedEnvelopes, error: insertEnvError } = await supabaseClient.from("envelopes").insert(rows).select("id,name");
    if (insertEnvError) throw insertEnvError;
    const ids = new Map(savedEnvelopes.map(e => [e.name, e.id]));
    const txRows = transactions.map(t => {
        const transfer = t.type === "transfer";
        const sourceName = transfer ? t.source : t.envelope;
        return { user_id: activeUser.id, budget_id: cloudBudgetId, envelope_id: ids.get(sourceName),
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
    setText("totalSpent", money(totalSpent()));
    setText("actualBalance", money(actualBalance()));
    setText("envelopeCount", `${envelopes.length} ${envelopes.length === 1 ? "envelope" : "envelopes"}`);
    const days = new Date(new Date().getFullYear(), new Date().getMonth() + 1, 0).getDate() - new Date().getDate();
    setText("daysLeft", String(days));
    const list = $("envelopeList");
    if (!list) return;
    list.replaceChildren();
    list.className = "envelope-list";
    if (!envelopes.length) {
        const empty = document.createElement("p");
        empty.textContent = "No envelopes yet. Open Budget Setup to add one.";
        list.appendChild(empty);
        return;
    }
    envelopes.forEach(envelope => {
        const card = document.createElement("article");
        card.className = "envelope-card";
        const top = document.createElement("div");
        top.className = "envelope-top";
        const title = document.createElement("h3");
        title.textContent = envelope.name;
        const balance = document.createElement("p");
        balance.className = "envelope-balance";
        balance.textContent = money(envelope.budget - envelope.spent);
        top.append(title, balance);
        const progress = document.createElement("div");
        progress.className = "progress-track";
        const fill = document.createElement("div");
        fill.className = "progress-fill";
        fill.style.width = `${envelope.budget > 0 ? Math.max(0, Math.min(100, (envelope.budget - envelope.spent) / envelope.budget * 100)) : 0}%`;
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

function renderSetup() {
    setText("setupIncome", money(monthlyIncome));
    setText("setupBudgeted", money(totalBudget()));
    setText("setupUnallocated", money(availableIncome()));
    setText("setupEnvelopeCount", `${envelopes.length} ${envelopes.length === 1 ? "envelope" : "envelopes"}`);
    const incomeInput = $("monthlyIncomeInput");
    if (incomeInput && document.activeElement !== incomeInput) incomeInput.value = monthlyIncome;
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
    $("editEnvelopeBudget").value = envelope.budget;
    setText("editEnvelopeSpentNote", `Already spent: ${money(envelope.spent)}`);
    setText("editEnvelopeUnallocated", `Unallocated amount: ${money(availableIncome())}`);
    clearMessage("editEnvelopeMessage");
    showPage("editEnvelopePage");
}

function saveEnvelopeEdits() {
    const envelope = findEnvelope(editingEnvelopeName);
    if (!envelope) return setMessage("editEnvelopeMessage", "Envelope not found.");
    const newName = $("editEnvelopeName").value.trim();
    const newBudget = Number($("editEnvelopeBudget").value);
    if (!newName) return setMessage("editEnvelopeMessage", "Enter an envelope name.");
    if (envelopes.some(e => e !== envelope && e.name.toLowerCase() === newName.toLowerCase())) return setMessage("editEnvelopeMessage", "An envelope with this name already exists.");
    if (!Number.isFinite(newBudget) || newBudget < envelope.spent) return setMessage("editEnvelopeMessage", `Budget must be at least ${money(envelope.spent)}.`);
    if (totalBudget() - envelope.budget + newBudget > monthlyIncome) return setMessage("editEnvelopeMessage", "Total budgets cannot exceed monthly income.");
    const oldName = envelope.name;
    envelope.name = newName;
    envelope.budget = newBudget;
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
    if (hasHistory || envelope.spent > 0) return setMessage("editEnvelopeMessage", "This envelope has spending or transfer history and cannot be deleted.");
    if (!confirm(`Delete the envelope “${name}”?`)) return;
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
    placeholder.textContent = "Select an envelope";
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
    setText("historyCount", `${transactions.length} ${transactions.length === 1 ? "transaction" : "transactions"}`);
    setText("historyEmptyMessage", transactions.length ? "" : "No transactions recorded yet.");
    const toggle = $("toggleHistoryManagement");
    if (toggle) toggle.textContent = historyManageMode ? "Done" : "Edit Transactions";
    const panel = $("historyManagementPanel");
    if (panel) panel.hidden = !historyManageMode;
    [...transactions].sort((a, b) => String(b.date || "").localeCompare(String(a.date || ""))).forEach(t => {
        const row = document.createElement("div");
        row.className = "transaction-item";
        const details = document.createElement("div"); details.className = "transaction-main-details";
        const desc = document.createElement("strong"); desc.textContent = t.description || (t.type === "transfer" ? "Budget transfer" : "Expense");
        const category = document.createElement("span"); category.textContent = t.type === "transfer" ? `${t.source} → ${t.destination}` : (t.envelope || "—");
        const date = document.createElement("span"); date.className = "transaction-date"; date.textContent = t.date || "";
        details.append(desc, category, date);
        const amount = document.createElement("strong"); amount.className = "transaction-amount"; amount.textContent = money(t.amount);
        row.append(details, amount);
        if (historyManageMode) {
            const actions = document.createElement("div"); actions.className = "transaction-actions";
            if (t.type !== "transfer") {
                const edit = document.createElement("button"); edit.type = "button"; edit.className = "secondary-button"; edit.textContent = "Modify";
                edit.addEventListener("click", () => openTransactionEditor(t)); actions.appendChild(edit);
            }
            const remove = document.createElement("button"); remove.type = "button"; remove.className = "danger-button"; remove.textContent = "Delete";
            remove.addEventListener("click", () => deleteSingleTransaction(t.id)); actions.appendChild(remove);
            row.appendChild(actions);
        }
        list.appendChild(row);
    });
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
    const availableInTarget = nextEnvelope.budget - nextEnvelope.spent + (nextEnvelope.name === old.envelope ? old.amount : 0);
    if (amount > availableInTarget) return setMessage("editTransactionMessage", "The new amount exceeds the selected envelope's remaining budget.");
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
    if (!confirm("Delete this transaction? The envelope balance will be adjusted.")) return;
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
    if (!confirm(`Delete ${selected.length} transaction(s) dated ${from} through ${to}? Envelope balances will be adjusted.`)) return;
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
    if (!confirm(`Delete all ${transactions.length} transactions? Envelope balances will be adjusted.`)) return;
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
        placeholder.textContent = index === 0 ? "Select source envelope" : "Select destination envelope";
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

// ==================== FORM HANDLERS ====================

const REMEMBER_EMAIL_KEY = "monetaTribeRememberedEmail";

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
    if ($("rememberMe")?.checked) localStorage.setItem(REMEMBER_EMAIL_KEY, email);
    else localStorage.removeItem(REMEMBER_EMAIL_KEY);
    try { await loadCloudData(); clearMessage("message"); showPage("homePage"); }
    catch (err) { setMessage("message", "Signed in, but cloud data could not load: " + err.message); }
});

$("createAccount")?.addEventListener("click", () => showPage("createAccountPage"));
$("backToLogin")?.addEventListener("click", () => showPage("loginPage"));
$("registerForm")?.addEventListener("submit", async event => {
    event.preventDefault();
    const name = $("registerName").value.trim();
    const email = $("registerEmail").value.trim().toLowerCase();
    const password = $("registerPassword").value;
    const button = $("registerForm").querySelector('button[type="submit"]');
    if (button) button.disabled = true;
    const { data, error } = await supabaseClient.auth.signUp({ email, password, options: { data: { full_name: name },emailRedirectTo: 'https://renjumathew7.github.io/MonetaTribe/' } });
    if (button) button.disabled = false;
    if (error) { alert(error.message); return; }
    if (data.session && data.user) {
        activeUser = data.user;
        try { await loadCloudData(); showPage("homePage"); }
        catch (err) { alert("Account created, but data setup failed: " + err.message); }
    } else {
        alert("Account created. Check your email to confirm your account, then log in.");
        $("loginEmail").value = email; showPage("loginPage");
    }
});

const rememberedEmail = localStorage.getItem(REMEMBER_EMAIL_KEY);
if (rememberedEmail) {
    $("loginEmail").value = rememberedEmail;
    $("rememberMe").checked = true;
}

$("logoutButton")?.addEventListener("click", async () => {
    await supabaseClient.auth.signOut();
    activeUser = null; cloudBudgetId = null; showPage("loginPage");
});
$("backToHome")?.addEventListener("click", () => { renderDashboard(); showPage("homePage"); });
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
        alert("Monthly income cannot be less than the total envelope budgets.");
        renderSetup();
        return;
    }
    monthlyIncome = value;
    refreshAll();
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
    if (!name) return setMessage("addEnvelopeMessage", "Enter an envelope name.");
    if (envelopes.some(e => e.name.toLowerCase() === name.toLowerCase())) return setMessage("addEnvelopeMessage", "An envelope with this name already exists.");
    if (!Number.isFinite(budget) || budget <= 0) return setMessage("addEnvelopeMessage", "Enter a budget greater than zero.");
    if (totalBudget() + budget > monthlyIncome) return setMessage("addEnvelopeMessage", "This exceeds your unallocated monthly income.");
    envelopes.push({ name, budget, spent: 0 });
    refreshAll();
    if (addAnother) {
        $("addEnvelopeForm")?.reset();
        renderAddEnvelopeSummary();
        setMessage("addEnvelopeMessage", "Envelope saved. You can add another.", false);
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
    if (!envelope) return setMessage("transactionMessage", "Choose an envelope.");
    if (!Number.isFinite(amount) || amount <= 0) return setMessage("transactionMessage", "Enter an amount greater than zero.");
    if (!description) return setMessage("transactionMessage", "Enter a description.");
    if (!date) return setMessage("transactionMessage", "Choose a date.");
    if (envelope.spent + amount > envelope.budget) return setMessage("transactionMessage", "This expense exceeds the envelope's remaining budget.");
    if (amount > actualBalance()) return setMessage("transactionMessage", "There is not enough overall balance for this expense.");
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
    if (!source || !destination) return setMessage("transferMessage", "Select both envelopes.");
    if (source === destination) return setMessage("transferMessage", "Choose two different envelopes.");
    if (!Number.isFinite(amount) || amount <= 0) return setMessage("transferMessage", "Enter an amount greater than zero.");
    if (amount > source.budget - source.spent) return setMessage("transferMessage", "The source envelope does not have enough unspent budget.");
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
    if ($("editTransactionForm")) $("editTransactionForm").hidden = true;
    renderDashboard();
    showPage("homePage");
});

$("toggleHistoryManagement")?.addEventListener("click", () => {
    historyManageMode = !historyManageMode;
    if (!historyManageMode) $("editTransactionForm").hidden = true;
    renderHistory();
});
$("editTransactionForm")?.addEventListener("submit", saveEditedTransaction);
$("cancelEditTransaction")?.addEventListener("click", () => { $("editTransactionForm").hidden = true; clearMessage("editTransactionMessage"); });

$("deleteTransactionsPeriod")?.addEventListener("click", deleteTransactionsByPeriod);
$("deleteAllTransactions")?.addEventListener("click", deleteAllTransactions);

// Restore a valid Supabase session after reload.
refreshAll();
showPage("loginPage");
supabaseClient.auth.getSession().then(async ({ data, error }) => {
    if (error || !data.session) return;
    activeUser = data.session.user;
    try { await loadCloudData(); showPage("homePage"); }
    catch (err) { console.error("Could not restore cloud data:", err); alert("You are signed in, but your cloud data could not be loaded: " + err.message); }
});
