const currentUser = JSON.parse(localStorage.getItem("currentUser"));
    const token = localStorage.getItem("token");
    let patientRequestEvents = null;
    if (!currentUser || currentUser.role !== "patient") window.location.href = "/login.html";

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
      const headers = { "Authorization": `Bearer ${token}` };
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
    function showMessage(id, message, type = "success") {
      document.getElementById(id).innerHTML = `<div class="result ${type}">${message}</div>`;
    }

    function clearPatientDashboard() {
      ["codeMessage", "profileMessage", "requestList", "historyList", "complaintMessage", "myComplaintsList"].forEach(id => {
        const element = document.getElementById(id);
        if (element) element.innerHTML = "";
      });
      const profileForm = document.getElementById("profileForm");
      if (profileForm) profileForm.reset();
      document.getElementById("profilePhotoPreview").innerHTML = "";
    }

    function startPatientRequestStream() {
      if (patientRequestEvents || typeof EventSource === "undefined") return;

      patientRequestEvents = new EventSource(`/api/visit-requests/review/events?token=${encodeURIComponent(token)}`);
      patientRequestEvents.addEventListener("patient-requests-updated", () => {
        if (!document.getElementById("requestsPanel").classList.contains("hidden")) {
          loadRequests(false);
        }
      });
      patientRequestEvents.onerror = () => {
        patientRequestEvents.close();
        patientRequestEvents = null;
      };
    }

    async function loadProfileCode() {
      const response = await fetch("/api/auth/me", { headers: authHeaders(false) });
      const user = await response.json();
      document.getElementById("visitorCode").textContent = response.ok && user.patientVisitorCode ? user.patientVisitorCode : "No code generated yet";
      document.getElementById("patientNote").textContent = response.ok && user.restrictionNote
        ? `Restriction note: ${user.restrictionNote}`
        : "";
    }

    async function generateVisitorCode() {
      const response = await fetch("/api/patient/visitor-code", { method: "POST", headers: authHeaders() });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) {
        showMessage("codeMessage", data.message || "Could not generate code.", "error");
        return;
      }
      document.getElementById("visitorCode").textContent = data.patientVisitorCode;
      showMessage("codeMessage", "New visitor code saved.", "success");
    }

    async function loadRequests(fullHistory) {
      const box = fullHistory ? document.getElementById("historyList") : document.getElementById("requestList");
      box.innerHTML = "<p>Loading requests...</p>";
      const url = fullHistory ? "/api/visit-requests/review?history=full" : "/api/visit-requests/review";
      const response = await fetch(url, { headers: authHeaders(false) });
      const requests = await response.json();
      if (!response.ok) {
        box.innerHTML = "<p>Could not load requests.</p>";
        return;
      }
      if (requests.length === 0) {
        box.innerHTML = "<p>No requests found.</p>";
        return;
      }
      box.innerHTML = requests.map(req => {
        const createdAt = req.createdAt ? new Date(req.createdAt).toLocaleString() : "";
        return `
          <div class="card">
            <p><strong>Visitor:</strong> ${req.visitorName}</p>
            <p><strong>Date:</strong> ${req.visitDate}</p>
            <p><strong>Time Slot:</strong> ${req.visitTimeSlot || "Not recorded"}</p>
            <p><strong>Reason:</strong> ${req.reason}</p>
            <p><strong>Status:</strong> ${req.status}</p>
            ${req.passCode ? `<p><strong>Pass Code:</strong> ${req.passCode}</p>` : ""}
            ${createdAt ? `<p><strong>Requested At:</strong> ${createdAt}</p>` : ""}
            ${req.status === "Pending" ? `
              <button class="action approve" data-action-code="updateRequestStatus('${req._id}', 'Approved by Patient', ${fullHistory})">Approve</button>
              <button class="action reject" data-action-code="updateRequestStatus('${req._id}', 'Rejected by Patient', ${fullHistory})">Reject</button>
            ` : ""}
          </div>
        `;
      }).join("");
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
      document.getElementById("profilePhotoPreview").innerHTML = profile.photo ? `<img src="${profile.photo}" alt="Profile photo" class="profile-photo-preview-img">` : "<p class='muted'>No photo uploaded.</p>";
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

    document.getElementById("profileForm").addEventListener("submit", async function(e) {
      e.preventDefault();
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
    });

    async function updateRequestStatus(id, status, fullHistory) {
      const response = await fetch(`/api/visit-requests/${id}/status`, {
        method: "PATCH",
        headers: authHeaders(),
        body: JSON.stringify({ status })
      });
      const data = await response.json();
      if (!response.ok) {
        alert(data.message || "Could not update request.");
        return;
      }
      loadRequests(fullHistory);
    }

    function showComplaintPanel() {
      showPanel("complaintPanel");
      loadMyComplaints();
    }

    async function submitComplaint(e) {
      if (e) e.preventDefault();
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

    document.getElementById("complaintForm").addEventListener("submit", submitComplaint);

    document.addEventListener("click", function(e) {
      if (!e.target.closest(".menu-wrap")) closeMenu();
    });
    function toggleMenu() { document.getElementById("dashboardMenu").classList.toggle("open"); }
    function closeMenu() { document.getElementById("dashboardMenu").classList.remove("open"); }
    function showPanel(panelId) {
      document.querySelectorAll(".section").forEach(section => section.classList.add("hidden"));
      document.getElementById(panelId).classList.remove("hidden");
      closeMenu();
    }
    function refreshDashboard() {
      closeMenu();
      clearPatientDashboard();
      showPanel("requestsPanel");
      loadProfileCode();
      loadRequests(false);
    }

    loadProfileCode();
    loadRequests(false);
    startPatientRequestStream();
    window.addEventListener("beforeunload", () => {
      if (patientRequestEvents) patientRequestEvents.close();
    });
