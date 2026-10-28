
"use strict";

// =====================================
// 1. GET HTML ELEMENTS
// =====================================

const loginForm = document.getElementById("loginForm");
const loginCard = loginForm.closest(".login-card");

const createAccountPage = document.getElementById("createAccountPage");
const createAccountButton = document.getElementById("createAccount");
const backToLogin = document.getElementById("backToLogin");
const registerForm = document.getElementById("registerForm");
const message = document.getElementById("message");

const homePage = document.getElementById("homePage");
const setupPage = document.getElementById("setupPage");
const addEnvelopePage = document.getElementById("addEnvelopePage");

const addEnvelopeButton = document.getElementById("addEnvelopeButton");
const cancelAddEnvelope = document.getElementById("cancelAddEnvelope");
const addEnvelopeForm = document.getElementById("addEnvelopeForm");
const addAnotherEnvelope = document.getElementById("addAnotherEnvelope");

const monthlyIncomeInput = document.getElementById("monthlyIncomeInput");
const envelopeNameInput = document.getElementById("envelopeName");
const envelopeBudgetInput = document.getElementById("envelopeBudget");
const addEnvelopeMessage = document.getElementById("addEnvelopeMessage");

// =====================================
// 2. TEMPORARY SAMPLE DATA
// =====================================

const envelopes = [
    { name: "Groceries", budget: 8000, spent: 3500 },
    { name: "Fuel", budget: 4000, spent: 2400 },
    { name: "Household", budget: 3000, spent: 1800 },
    { name: "Entertainment", budget: 2000, spent: 500 }
];

let monthlyIncome = 40000;

// =====================================
// 3. COMMON FUNCTIONS
// =====================================

function formatMoney(amount) {
    return new Intl.NumberFormat("en-IN", {
        style: "currency",
        currency: "INR",
        maximumFractionDigits: 0
    }).format(amount);
}

function getTotalBudgeted() {
    return envelopes.reduce(
        (total, envelope) => total + envelope.budget,
        0
    );
}

function showPage(pageToShow) {
    const pages = [
        loginCard,
        createAccountPage,
        homePage,
        setupPage,
        addEnvelopePage
    ];

    pages.forEach(page => {
        page.hidden = true;
    });

    pageToShow.hidden = false;
}

// =====================================
// 4. DASHBOARD
// =====================================

function renderDashboard() {
    const totalSpent = envelopes.reduce(
        (total, envelope) => total + envelope.spent,
        0
    );

    const actualBalance = monthlyIncome - totalSpent;

    const today = new Date();
    const lastDay = new Date(
        today.getFullYear(),
        today.getMonth() + 1,
        0
    );

    document.getElementById("totalSpent").textContent =
        formatMoney(totalSpent);

    document.getElementById("actualBalance").textContent =
        formatMoney(actualBalance);

    document.getElementById("daysLeft").textContent =
        lastDay.getDate() - today.getDate();

    document.getElementById("budgetPeriod").textContent =
        today.toLocaleDateString("en-IN", {
            month: "long",
            year: "numeric"
        });

    document.getElementById("envelopeCount").textContent =
        `${envelopes.length} envelopes`;

    const list = document.getElementById("envelopeList");
    list.innerHTML = "";

    envelopes.forEach(envelope => {
        const balance = envelope.budget - envelope.spent;

        const percentage = envelope.budget > 0
            ? Math.min(100, envelope.spent / envelope.budget * 100)
            : 0;

        const card = document.createElement("article");
        card.className = "envelope-card";

        card.innerHTML = `
            <div class="envelope-top">
                <h3></h3>
                <span class="envelope-balance"></span>
            </div>
            <div class="progress-track">
                <div class="progress-fill"></div>
            </div>
            <div class="envelope-amounts">
                <span class="spent-amount"></span>
                <span class="budget-amount"></span>
            </div>
        `;

        card.querySelector("h3").textContent = envelope.name;
        card.querySelector(".envelope-balance").textContent =
            `${formatMoney(balance)} left`;
        card.querySelector(".progress-fill").style.width =
            `${percentage}%`;
        card.querySelector(".spent-amount").textContent =
            `Spent: ${formatMoney(envelope.spent)}`;
        card.querySelector(".budget-amount").textContent =
            `Budget: ${formatMoney(envelope.budget)}`;

        list.appendChild(card);
    });
}

// =====================================
// 5. SETUP PAGE
// =====================================

function renderSetup() {
    const totalBudgeted = getTotalBudgeted();
    const unallocated = monthlyIncome - totalBudgeted;

    monthlyIncomeInput.value = monthlyIncome;

    document.getElementById("setupIncome").textContent =
        formatMoney(monthlyIncome);
    document.getElementById("setupBudgeted").textContent =
        formatMoney(totalBudgeted);
    document.getElementById("setupUnallocated").textContent =
        formatMoney(unallocated);
    document.getElementById("setupEnvelopeCount").textContent =
        `${envelopes.length} envelopes`;

    const list = document.getElementById("setupEnvelopeList");
    list.innerHTML = "";

    envelopes.forEach(envelope => {
        const item = document.createElement("p");
        item.textContent =
            `${envelope.name} — ${formatMoney(envelope.budget)}`;
        list.appendChild(item);
    });
}

// =====================================
// 6. ADD ENVELOPE PAGE
// =====================================

function renderAddEnvelope() {
    const totalBudgeted = getTotalBudgeted();
    const available = monthlyIncome - totalBudgeted;

    document.getElementById("addEnvelopeIncome").textContent =
        formatMoney(monthlyIncome);
    document.getElementById("addEnvelopeBudgeted").textContent =
        formatMoney(totalBudgeted);
    document.getElementById("addEnvelopeAvailable").textContent =
        formatMoney(available);

    envelopeBudgetInput.max = Math.max(0, available);
    addEnvelopeMessage.textContent = "";
}

function saveEnvelope() {
    const name = envelopeNameInput.value.trim();
    const budget = Number(envelopeBudgetInput.value);
    const available = monthlyIncome - getTotalBudgeted();

    if (!name) {
        addEnvelopeMessage.textContent =
            "Please enter an envelope name.";
        return false;
    }

    if (envelopes.some(
        envelope => envelope.name.toLowerCase() === name.toLowerCase()
    )) {
        addEnvelopeMessage.textContent =
            "An envelope with this name already exists.";
        return false;
    }

    if (!Number.isSafeInteger(budget) || budget <= 0) {
        addEnvelopeMessage.textContent =
            "Enter a whole-number budget greater than zero.";
        return false;
    }

    if (budget > available) {
        addEnvelopeMessage.textContent =
            `Only ${formatMoney(available)} is available to allocate.`;
        return false;
    }

    envelopes.push({
        name: name,
        budget: budget,
        spent: 0
    });

    return true;
}

// =====================================
// 7. LOGIN AND REGISTRATION
// =====================================

createAccountButton.addEventListener("click", function () {
    message.textContent = "";
    showPage(createAccountPage);
});

backToLogin.addEventListener("click", function () {
    message.textContent = "";
    showPage(loginCard);
});

loginForm.addEventListener("submit", function (event) {
    event.preventDefault();

    // Temporary demonstration; authentication comes later.
    renderDashboard();
    showPage(homePage);
});

registerForm.addEventListener("submit", function (event) {
    event.preventDefault();

    alert(
        "Account registration will be enabled when Supabase is connected."
    );
});

// =====================================
// 8. DASHBOARD NAVIGATION
// =====================================

document.querySelectorAll(".dashboard-actions button[data-page]")
    .forEach(button => {
        button.addEventListener("click", function () {
            const destination = button.dataset.page;

            if (destination === "setupPage") {
                renderSetup();
                showPage(setupPage);
            } else {
                alert(`${destination} will be built in a later step.`);
            }
        });
    });

// =====================================
// 9. SETUP → ADD ENVELOPE
// =====================================

addEnvelopeButton.addEventListener("click", function () {
    renderAddEnvelope();
    showPage(addEnvelopePage);
});

// =====================================
// 10. MONTHLY INCOME
// =====================================

monthlyIncomeInput.addEventListener("change", function () {
    const newIncome = Number(this.value);
    const totalBudgeted = getTotalBudgeted();

    if (
        !Number.isSafeInteger(newIncome) ||
        newIncome < totalBudgeted ||
        newIncome < 0
    ) {
        alert(
            `Income must be a whole number of at least ${formatMoney(totalBudgeted)}.`
        );

        this.value = monthlyIncome;
        return;
    }

    monthlyIncome = newIncome;
    renderSetup();
});

// =====================================
// 11. ADD ENVELOPE BUTTONS
// =====================================

// Cancel: return to Setup
cancelAddEnvelope.addEventListener("click", function () {
    renderSetup();
    showPage(setupPage);
});

// Add: save and return to Setup
addEnvelopeForm.addEventListener("submit", function (event) {
    event.preventDefault();

    if (!saveEnvelope()) {
        return;
    }

    addEnvelopeForm.reset();
    renderSetup();
    showPage(setupPage);
});

// Add New: save and clear the form
addAnotherEnvelope.addEventListener("click", function () {
    if (!addEnvelopeForm.reportValidity()) {
        return;
    }

    if (!saveEnvelope()) {
        return;
    }

    addEnvelopeForm.reset();
    renderAddEnvelope();
    envelopeNameInput.focus();
});

// =====================================
// 12. HOME AND LOGOUT
// =====================================

document.getElementById("backToHome").addEventListener("click", function () {
    renderDashboard();
    showPage(homePage);
});

document.getElementById("logoutButton").addEventListener("click", function () {
    showPage(loginCard);
});
