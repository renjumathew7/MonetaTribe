"use strict";

const STORAGE_KEY = "monetaTribeData";

// Pages and elements use the IDs from index.html.
const pageIds = ["loginPage", "createAccountPage", "homePage", "setupPage", "addEnvelopePage", "transactionPage", "historyPage", "transferPage"];
const $ = id => document.getElementById(id);

const defaultEnvelopes = [
    { name: "Groceries", budget: 8000, spent: 3500 },
    { name: "Fuel", budget: 4000, spent: 2400 },
    { name: "Household", budget: 3000, spent: 1800 },
    { name: "Entertainment", budget: 2000, spent: 500 }
];

let envelopes = defaultEnvelopes.map(e => ({ ...e }));
let transactions = [];
let monthlyIncome = 40000;

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
        console.error("Unable to save Moneta Tribe data:", error);
        alert("Your browser could not save the data. Check browser storage settings.");
    }
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

// Envelope action controls appear only in Budget Setup.
function makeEnvelopeActions(envelopeName) {
    const wrapper = document.createElement("div");
    wrapper.className = "envelope-actions";
    const edit = document.createElement("button");
    edit.type = "button";
    edit.className = "envelope-edit-button";
    edit.textContent = "Edit";
    edit.addEventListener("click", () => editEnvelope(envelopeName));
    const del = document.createElement("button");
    del.type = "button";
    del.className = "envelope-delete-button";
    del.textContent = "Delete";
    del.addEventListener("click", () => deleteEnvelope(envelopeName));
    wrapper.append(edit, del);
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
        fill.style.width = `${envelope.budget > 0 ? Math.min(100, envelope.spent / envelope.budget * 100) : 0}%`;
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

function editEnvelope(name) {
    const envelope = findEnvelope(name);
    if (!envelope) return alert("Envelope not found.");
    const enteredName = prompt("Envelope name:", envelope.name);
    if (enteredName === null) return;
    const newName = enteredName.trim();
    if (!newName) return alert("Envelope name cannot be empty.");
    if (envelopes.some(e => e !== envelope && e.name.toLowerCase() === newName.toLowerCase())) {
        return alert("An envelope with that name already exists.");
    }
    const enteredBudget = prompt("Monthly budget (₹):", String(envelope.budget));
    if (enteredBudget === null) return;
    const newBudget = Number(enteredBudget);
    if (!Number.isFinite(newBudget) || newBudget < 0) return alert("Enter a valid budget of zero or more.");
    if (newBudget < envelope.spent) return alert("Budget cannot be lower than the amount already spent.");
    const otherBudgets = totalBudget() - envelope.budget;
    if (otherBudgets + newBudget > monthlyIncome) return alert("Total budgets cannot exceed monthly income.");
    const oldName = envelope.name;
    envelope.name = newName;
    envelope.budget = newBudget;
    transactions.forEach(t => {
        if (t.envelope === oldName) t.envelope = newName;
        if (t.source === oldName) t.source = newName;
        if (t.destination === oldName) t.destination = newName;
    });
    refreshAll();
}

function deleteEnvelope(name) {
    const envelope = findEnvelope(name);
    if (!envelope) return alert("Envelope not found.");
    const hasHistory = transactions.some(t => t.envelope === name || t.source === name || t.destination === name);
    if (hasHistory || envelope.spent > 0) {
        return alert("This envelope has spending or transfer history, so it cannot be deleted. You can edit its name or budget instead.");
    }
    if (!confirm(`Delete the envelope “${name}”?`)) return;
    envelopes = envelopes.filter(e => e !== envelope);
    refreshAll();
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
    [...transactions].sort((a, b) => String(b.date || "").localeCompare(String(a.date || ""))).forEach(t => {
        const row = document.createElement("div");
        row.className = "transaction-item";
        const desc = document.createElement("span"); desc.textContent = t.description || (t.type === "transfer" ? "Budget transfer" : "Expense");
        const category = document.createElement("span"); category.textContent = t.type === "transfer" ? `${t.source} → ${t.destination}` : (t.envelope || "—");
        const date = document.createElement("span"); date.textContent = t.date || "";
        const amount = document.createElement("strong"); amount.textContent = money(t.amount);
        row.append(desc, category, date, amount);
        list.appendChild(row);
    });
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

$("loginForm")?.addEventListener("submit", event => {
    event.preventDefault();
    // Prototype-only entry: no real account authentication is configured.
    clearMessage("message");
    showPage("homePage");
});

$("createAccount")?.addEventListener("click", () => showPage("createAccountPage"));
$("backToLogin")?.addEventListener("click", () => showPage("loginPage"));
$("registerForm")?.addEventListener("submit", event => {
    event.preventDefault();
    alert("Account creation is not connected to a secure backend yet. This prototype stores budget data in this browser only.");
    showPage("loginPage");
});

$("logoutButton")?.addEventListener("click", () => showPage("loginPage"));
$("backToHome")?.addEventListener("click", () => { renderDashboard(); showPage("homePage"); });
$("historyBackToHome")?.addEventListener("click", () => showPage("homePage"));
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

$("transactionForm")?.addEventListener("submit", event => {
    event.preventDefault();
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
    envelope.spent += amount;
    transactions.push({ id: Date.now(), type: "expense", envelope: envelope.name, amount, description, date });
    refreshAll();
    $("transactionForm").reset();
    renderTransactionForm();
    setMessage("transactionMessage", "Transaction saved successfully.", false);
    showPage("homePage");
});

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

// Initial view: show the login page. Budget data remains saved in this browser.
refreshAll();
showPage("loginPage");
