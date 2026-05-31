const currentUser = JSON.parse(localStorage.getItem("currentUser"));
const token = localStorage.getItem("token");
let assignedPatients = [];

if (!currentUser || currentUser.role !== "doctor") {
  window.location.href = "/login.html";
}

function logout() {
  localStorage.removeItem("currentUser");
  localStorage.removeItem("token");
  window.location.href = "/login.html";
}

function clearSessionAndRedirect() {
  localStorage.removeItem("currentUser");
  localStorage.removeItem("token");
  sessionStorage.clear();
  window.location.href = "/login.html";
}

function authHeaders(contentType = true) {
  const headers = { Authorization: `Bearer ${token}` };
  if (contentType) headers["Content-Type"] = "application/json";
  return headers;
}

function formatDateForInput(value) {
  if (!value) return "";

  const date = new Date(value);

  if (Number.isNaN(date.getTime())) {
    return "";
  }

  return date.toISOString().split("T")[0];
}

function escapeHtml(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function eligibilityToStatus(value) {
  return value === "restricted" || value === "Not Eligible" ? "Not Eligible" : "Eligible";
}

function displayEligibility(value) {
  return eligibilityToStatus(value) === "Not Eligible" ? "Restricted" : "Allowed";
}

function showMessage(id, message, type = "success") {
  const element = document.getElementById(id);
  if (element) {
    element.innerHTML = `<div class="result ${type}">${escapeHtml(message)}</div>`;
  }
}

function clearDoctorDashboard() {
  ["patientList", "scheduleList", "profileMessage", "complaintMessage", "myComplaintsList"].forEach(id => {
    const element = document.getElementById(id);
    if (element) element.innerHTML = "";
  });

  const profileForm = document.getElementById("profileForm");
  if (profileForm) profileForm.reset();

  const profilePhotoPreview = document.getElementById("profilePhotoPreview");
  if (profilePhotoPreview) profilePhotoPreview.innerHTML = "";
}

async function loadMyPatients() {
  const box = document.getElementById("patientList");
  box.innerHTML = "<p>Loading patients...</p>";

  try {
    const response = await fetch("/api/doctor/my-patients", { headers: authHeaders(false) });
    const data = await response.json();
    assignedPatients = Array.isArray(data) ? data : [];

    if (!response.ok) {
      box.innerHTML = `<p>${escapeHtml(data.message || "Could not load assigned patients.")}</p>`;
      return;
    }

    renderPatients(assignedPatients);
  } catch (error) {
    box.innerHTML = "<p>Could not load assigned patients.</p>";
  }
}

function renderPatients(patients) {
  const box = document.getElementById("patientList");

  if (!patients.length) {
    box.innerHTML = "<p>No patients assigned to you yet.</p>";
    return;
  }

  box.innerHTML = patients.map(patient => {
    const status = eligibilityToStatus(patient.visitEligibilityStatus);
    const note = patient.restrictionNote || "";

    return `
      <div class="card">
        <p><strong>Name:</strong> ${escapeHtml(patient.fullName)}</p>
        <p><strong>Email:</strong> ${escapeHtml(patient.email)}</p>
        <p><strong>Date of Birth:</strong> ${escapeHtml(patient.birthDate || "Not recorded")}</p>
        <p><strong>Address:</strong> ${escapeHtml(patient.address || "Not recorded")}</p>
        <p><strong>Current Visit Eligibility:</strong> ${displayEligibility(status)}</p>
        <p><strong>Restriction Note:</strong> ${escapeHtml(note || "None")}</p>
        <label for="eligibility-${patient._id}"><strong>Update Eligibility</strong></label>
        <select id="eligibility-${patient._id}">
          <option value="allowed" ${status === "Eligible" ? "selected" : ""}>Allowed</option>
          <option value="restricted" ${status === "Not Eligible" ? "selected" : ""}>Restricted</option>
        </select>
        <label for="restriction-${patient._id}"><strong>Restriction Note</strong></label>
        <textarea id="restriction-${patient._id}" rows="3" placeholder="Add or update a patient restriction note">${escapeHtml(note)}</textarea>
        <button class="action approve" type="button" data-action-code="savePatientVisitRules('${patient._id}')">Save</button>
        <div id="patient-msg-${patient._id}"></div>
      </div>
    `;
  }).join("");
}

async function savePatientVisitRules(patientId) {
  const visitEligibility = document.getElementById(`eligibility-${patientId}`).value;
  const restrictionNote = document.getElementById(`restriction-${patientId}`).value.trim();

  if (visitEligibility === "restricted" && !restrictionNote) {
    showMessage(`patient-msg-${patientId}`, "Restriction note is required when restricting a patient.", "error");
    return;
  }

  const response = await fetch(`/api/doctor/patients/${patientId}/visit-rules`, {
    method: "PATCH",
    headers: authHeaders(),
    body: JSON.stringify({ visitEligibility, restrictionNote })
  });
  const data = await response.json().catch(() => ({}));

  showMessage(
    `patient-msg-${patientId}`,
    data.message || (response.ok ? "Patient visit rules saved." : "Could not save patient visit rules."),
    response.ok ? "success" : "error"
  );

  if (response.ok) {
    await loadMyPatients();
  }
}

async function updatePatientEligibility(patientId) {
  return savePatientVisitRules(patientId);
}

async function saveRestrictionNote(patientId) {
  return savePatientVisitRules(patientId);
}

async function loadVisitSchedules() {
  const box = document.getElementById("scheduleList");
  box.innerHTML = "<p>Loading schedules...</p>";

  try {
    const response = await fetch("/api/doctor/visit-schedules", { headers: authHeaders(false) });
    const schedules = await response.json();

    if (!response.ok) {
      box.innerHTML = `<p>${escapeHtml(schedules.message || "Could not load visit schedules.")}</p>`;
      return;
    }

    renderVisitSchedules(Array.isArray(schedules) ? schedules : []);
  } catch (error) {
    box.innerHTML = "<p>Could not load visit schedules.</p>";
  }
}

function renderVisitSchedules(schedules) {
  const box = document.getElementById("scheduleList");

  if (!schedules.length) {
    box.innerHTML = "<p>No visit schedules found.</p>";
    return;
  }

  box.innerHTML = schedules.map(req => `
    <div class="card">
      <p><strong>Visitor:</strong> ${escapeHtml(req.visitorName)}</p>
      <p><strong>Patient:</strong> ${escapeHtml(req.patientName)}</p>
      <p><strong>Date:</strong> ${escapeHtml(req.visitDate)}</p>
      <p><strong>Time Slot:</strong> ${escapeHtml(req.visitTimeSlot || "Not recorded")}</p>
      <p><strong>Status:</strong> ${escapeHtml(req.status)}</p>
    </div>
  `).join("");
}

async function loadProfile() {
  const response = await fetch("/api/auth/me", { headers: authHeaders(false) });
  const profile = await response.json();

  if (!response.ok) {
    showMessage("profileMessage", "Could not load profile.", "error");
    return;
  }

  document.getElementById("profileFullName").value = profile.fullName || "";
  document.getElementById("profileEmail").value = profile.email || "";
  document.getElementById("profileBirthDate").value = formatDateForInput(profile.birthDate);
  document.getElementById("profileAddress").value = profile.address || "";
  document.getElementById("profilePhotoPreview").innerHTML = profile.photo
    ? `<img src="${escapeHtml(profile.photo)}" alt="Profile photo" class="profile-photo-preview-img">`
    : "<p class='muted'>No photo uploaded.</p>";
}

async function deleteMyAccount() {
  if (!confirm("Are you sure you want to delete your account? This action cannot be undone.")) return;

  try {
    const response = await fetch("/api/account/me", {
      method: "DELETE",
      headers: authHeaders(false)
    });
    const data = await response.json();

    if (!response.ok) {
      throw new Error(data.message || "Could not delete account.");
    }

    alert(data.message || "Your account has been deleted. It may take up to 24 hours before you can register again.");
    clearSessionAndRedirect();
  } catch (error) {
    showMessage("profileMessage", error.message || "Could not delete account.", "error");
  }
}

async function updateProfile(event) {
  event.preventDefault();

  const response = await fetch("/api/auth/profile", {
    method: "PATCH",
    headers: authHeaders(),
    body: JSON.stringify({
      fullName: document.getElementById("profileFullName").value.trim(),
      birthDate: document.getElementById("profileBirthDate").value,
      address: document.getElementById("profileAddress").value.trim()
    })
  });
  const data = await response.json();

  showMessage("profileMessage", data.message || "Profile updated.", response.ok ? "success" : "error");
  if (response.ok) localStorage.setItem("currentUser", JSON.stringify(data.user));
}

function showComplaintPanel() {
  showPanel("complaintPanel");
  loadMyComplaints();
}

async function submitComplaint(event) {
  if (event) event.preventDefault();
  const subject = document.getElementById("complaintSubject").value.trim();
  const message = document.getElementById("complaintMessageText").value.trim();

  if (!subject || !message) {
    showMessage("complaintMessage", "Subject and complaint message are required.", "error");
    return;
  }

  const response = await fetch("/api/complaints", {
    method: "POST",
    headers: authHeaders(),
    body: JSON.stringify({ subject, message })
  });
  const data = await response.json();

  if (!response.ok) {
    showMessage("complaintMessage", data.message || "Could not submit complaint.", "error");
    return;
  }

  document.getElementById("complaintForm").reset();
  showMessage("complaintMessage", "Complaint submitted successfully.", "success");
  loadMyComplaints();
}

async function loadMyComplaints() {
  const box = document.getElementById("myComplaintsList");
  box.innerHTML = "<p>Loading complaints...</p>";
  const response = await fetch("/api/complaints/my", { headers: authHeaders(false) });
  const complaints = await response.json();

  if (!response.ok) {
    box.innerHTML = "<p>Could not load complaints.</p>";
    return;
  }

  renderMyComplaints(complaints);
}

function renderMyComplaints(complaints) {
  const box = document.getElementById("myComplaintsList");

  if (!complaints.length) {
    box.innerHTML = "<p>No complaints submitted yet.</p>";
    return;
  }

  box.innerHTML = complaints.map(complaint => `
    <div class="card">
      <p><strong>Subject:</strong> ${complaint.subject}</p>
      <p><strong>Message:</strong> ${complaint.message}</p>
      <p><strong>Status:</strong> ${complaint.status}</p>
      <p><strong>Submitted At:</strong> ${new Date(complaint.createdAt).toLocaleString()}</p>
      <p><strong>Admin Reply:</strong> ${complaint.adminReply || "Awaiting admin response"}</p>
      ${complaint.repliedAt ? `<p><strong>Replied At:</strong> ${new Date(complaint.repliedAt).toLocaleString()}</p>` : ""}
    </div>
  `).join("");
}

function toggleMenu() {
  document.getElementById("dashboardMenu").classList.toggle("open");
}

function closeMenu() {
  document.getElementById("dashboardMenu").classList.remove("open");
}

function showPanel(panelId) {
  document.querySelectorAll(".section").forEach(section => section.classList.add("hidden"));
  document.getElementById(panelId).classList.remove("hidden");
  closeMenu();
}

function refreshDashboard() {
  closeMenu();
  clearDoctorDashboard();
  showPanel("patientsPanel");
  loadMyPatients();
}

document.getElementById("profileForm").addEventListener("submit", updateProfile);
document.getElementById("complaintForm").addEventListener("submit", submitComplaint);
document.addEventListener("click", function(e) {
  if (!e.target.closest(".menu-wrap")) closeMenu();
});

loadMyPatients();
