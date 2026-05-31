const currentUser = JSON.parse(localStorage.getItem("currentUser"));
    const token = localStorage.getItem("token");
    let activeComplaintStatus = "Open";

    if (!currentUser || currentUser.role !== "admin") {
      window.location.href = "/login.html";
    }

    if (currentUser.email === "admin@hospital.com") {
      document.addEventListener("DOMContentLoaded", () => {
        const deleteButton = document.getElementById("deleteAccountBtn");
        if (deleteButton) deleteButton.classList.add("hidden");
      });
    }

    function toggleMenu() {
      document.getElementById("adminMenu").classList.toggle("open");
    }

    function closeMenu() {
      document.getElementById("adminMenu").classList.remove("open");
    }

    function showAdminPanel(panel) {
      closeMenu();

      const panels = [
        "dashboardPanel",
        "assignPanel",
        "requestsPanel",
        "settingsPanel",
        "activityPanel",
        "complaintsPanel",
        "profilePanel"
      ];

      panels.forEach(id => document.getElementById(id).classList.add("hidden"));

      const selectedPanel = document.getElementById(panel + "Panel");
      if (selectedPanel) selectedPanel.classList.remove("hidden");

      if (panel === "assign") loadDoctorsAndPatients();
      if (panel === "requests") loadRequests();
      if (panel === "settings") loadSettings();
      if (panel === "activity") loadSystemActivity();
      if (panel === "complaints") loadComplaints("Open");
      if (panel === "profile") loadProfile();
    }

    document.addEventListener("click", function(e) {
      if (!e.target.closest(".menu-wrap")) {
        closeMenu();
      }
    });

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

    function authHeaders() {
      return {
        "Authorization": `Bearer ${token}`
      };
    }

    function formatDateForInput(value) {
      if (!value) return "";

      const date = new Date(value);

      if (Number.isNaN(date.getTime())) {
        return "";
      }

      return date.toISOString().split("T")[0];
    }

    async function downloadAdminPdf(url, filename) {
      let response;
      try {
        response = await fetch(url, { headers: authHeaders() });
      } catch (error) {
        console.error(error);
        alert("Could not generate PDF.");
        return;
      }

      if (!response.ok) {
        let message = "Could not generate PDF.";
        try {
          const data = await response.json();
          message = data.message || message;
        } catch (error) {
          // Keep the default message when the response is not JSON.
        }
        alert(message);
        return;
      }

      const blob = await response.blob();
      const objectUrl = URL.createObjectURL(blob);
      const link = document.createElement("a");
      link.href = objectUrl;
      link.download = filename;
      link.target = "_blank";
      link.rel = "noopener";
      document.body.appendChild(link);
      link.click();
      link.remove();
      setTimeout(() => URL.revokeObjectURL(objectUrl), 1000);
    }

    function canAdminOverride(request) {
      const inactiveStatuses = [
        "Cancelled",
        "Rejected",
        "Rejected by Patient",
        "Rejected by Doctor",
        "Expired",
        "Completed",
        "Checked Out",
        "Exited"
      ];

      if (inactiveStatuses.includes(request.status)) return false;
      if (request.checkedOutAt || request.exitTime || request.exitedAt) return false;

      const expiryValue = request.expiresAt || request.passExpiresAt || request.qrExpiresAt || request.visitEndTime;
      if (expiryValue && new Date(expiryValue) < new Date()) return false;

      return true;
    }

    async function loadUsers() {
      const userList = document.getElementById("userList");
      userList.innerHTML = "<p class='muted'>Loading users...</p>";

      try {
        const response = await fetch("/api/admin/users", {
          headers: authHeaders()
        });

        const users = await response.json();

        if (!response.ok) {
          userList.innerHTML = "<p>Could not load users.</p>";
          return;
        }

        if (users.length === 0) {
          userList.innerHTML = "<p>No users found.</p>";
          return;
        }

        userList.innerHTML = `
          <div class="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Name</th>
                  <th>Email</th>
                  <th>Role</th>
                  <th>Restriction Note</th>
                  <th>Status</th>
                  <th>Details</th>
                  <th>Action</th>
                </tr>
              </thead>
              <tbody>
                ${users.map(user => `
                  <tr>
                    <td>${user.fullName}</td>
                    <td>${user.email}</td>
                    <td>${user.role}</td>
                    <td>${user.role === "patient" ? (user.restrictionNote || "None") : "-"}</td>
                    <td>${user.isDeleted === true ? "Deleted" : (user.isActive === false ? "Deactivated" : "Active")}</td>
                    <td><button type="button" class="action-btn secondary-btn" data-action-code="toggleUserDetails('${user._id}')">Show Data</button></td>
                    <td>
                      ${user.email === "admin@hospital.com" || user.isMainAdmin === true ? `
                        <span>Main admin</span>
                      ` : user.id === currentUser.id || user._id === currentUser.id ? `
                        <span>Current admin</span>
                      ` : user.isActive === false ? `
                        <button type="button" class="action-btn approve-btn" data-action-code="updateUserStatus('${user._id}', true)">Approve</button>
                      ` : `
                        <button type="button" class="action-btn reject-btn" data-action-code="updateUserStatus('${user._id}', false)">Reject</button>
                      `}
                    </td>
                  </tr>
                  <tr id="details-${user._id}" class="hidden">
                    <td colspan="8">
                      <div class="card">
                        <p><strong>Birth Date:</strong> ${user.birthDate || "-"}</p>
                        <p><strong>Address:</strong> ${user.address || "-"}</p>
                        <p><strong>Photo:</strong></p>
                        ${user.photo ? `<img src="${user.photo}" alt="User photo" class="user-detail-photo">` : "<p>No photo uploaded.</p>"}
                      </div>
                    </td>
                  </tr>
                `).join("")}
              </tbody>
            </table>
          </div>
        `;
      } catch (error) {
        console.error(error);
        userList.innerHTML = "<p>Could not load users.</p>";
      }
    }

    async function updateUserStatus(id, isActive) {
      try {
        const response = await fetch(`/api/admin/users/${id}/status`, {
          method: "PATCH",
          headers: {
            "Content-Type": "application/json",
            "Authorization": `Bearer ${token}`
          },
          body: JSON.stringify({ isActive })
        });

        const data = await response.json();

        if (!response.ok) {
          alert(data.message || "Could not update user status.");
          return;
        }

        loadUsers();
      } catch (error) {
        console.error(error);
        alert("Could not update user status.");
      }
    }

    function toggleUserDetails(id) {
      const row = document.getElementById(`details-${id}`);
      if (row) row.classList.toggle("hidden");
    }

    async function loadRequests() {
      const requestList = document.getElementById("requestListMenu");
      requestList.innerHTML = "<p class='muted'>Loading visit requests...</p>";

      try {
        const response = await fetch("/api/admin/visit-requests", {
          headers: authHeaders()
        });

        const requests = await response.json();

        if (!response.ok) {
          requestList.innerHTML = "<p>Could not load visit requests.</p>";
          return;
        }

        if (requests.length === 0) {
          requestList.innerHTML = "<p>No visit requests found.</p>";
          return;
        }

        requestList.innerHTML = requests.map(req => {
          const createdAt = req.createdAt ? new Date(req.createdAt).toLocaleString() : "";
          const exitedAt = req.exitedAt ? new Date(req.exitedAt).toLocaleString() : "";
          const expiresAt = req.expiresAt ? new Date(req.expiresAt).toLocaleString() : "";

          return `
            <div class="card">
              <p><strong>Visitor:</strong> ${req.visitorName}</p>
              <p><strong>Patient:</strong> ${req.patientName}</p>
              <p><strong>Date:</strong> ${req.visitDate}</p>
              <p><strong>Time Slot:</strong> ${req.visitTimeSlot || "Not recorded"}</p>
              <p><strong>Reason:</strong> ${req.reason}</p>
              <p><strong>Status:</strong> ${req.status}</p>
              ${createdAt ? `<p><strong>Requested At:</strong> ${createdAt}</p>` : ""}
              ${expiresAt ? `<p><strong>Expires At:</strong> ${expiresAt}</p>` : ""}
              ${exitedAt ? `<p><strong>Exited At:</strong> ${exitedAt}</p>` : ""}
              ${req.passCode ? `<p><strong>Pass Code:</strong> ${req.passCode}</p>` : ""}
              ${canAdminOverride(req) ? `
                <button type="button" class="action-btn approve-btn" data-action-code="overrideVisit('${req._id}')">
                  Override Approval
                </button>
              ` : ""}
            </div>
          `;
        }).join("");
      } catch (error) {
        console.error(error);
        requestList.innerHTML = "<p>Could not load visit requests.</p>";
      }
    }

    function printUsersPdf() {
      downloadAdminPdf("/api/admin/users/export-pdf", "medivisit-users-report.pdf");
    }

    async function overrideVisit(id) {
      try {
        const response = await fetch(`/api/admin/visit-requests/${id}/override`, {
          method: "PATCH",
          headers: authHeaders()
        });

        const data = await response.json();

        if (!response.ok) {
          alert(data.message || "Could not override visit approval.");
          return;
        }

        alert("Visit approval overridden.");
        loadRequests();
      } catch (error) {
        console.error(error);
        alert("Could not override visit approval.");
      }
    }

    function loadDashboard() {
      closeMenu();
      showAdminPanel("dashboard");
      loadUsers();
    }

    async function loadDoctorsAndPatients() {
      const box = document.getElementById("doctorAssignBox");
      box.innerHTML = "<p class='muted'>Loading...</p>";

      try {
        const doctorsRes = await fetch("/api/admin/doctors", {
          headers: authHeaders()
        });

        const patientsRes = await fetch("/api/admin/unassigned-patients", {
          headers: authHeaders()
        });

        const doctors = await doctorsRes.json();
        const patients = await patientsRes.json();

        if (!doctorsRes.ok || !patientsRes.ok) {
          box.innerHTML = "<p>Could not load doctors or patients.</p>";
          return;
        }

        if (doctors.length === 0) {
          box.innerHTML = "<p>No doctors found.</p>";
          return;
        }

        if (patients.length === 0) {
          box.innerHTML = "<p>No unassigned patients found.</p>";
          return;
        }

        box.innerHTML = patients.map(patient => `
          <div class="card">
            <p><strong>Patient:</strong> ${patient.fullName}</p>

            <select id="doctor-${patient._id}">
              <option value="">Select Doctor</option>
              ${doctors.map(doctor => `
                <option value="${doctor._id}">${doctor.fullName}</option>
              `).join("")}
            </select>

            <button type="button" class="action-btn" data-action-code="assignDoctor('${patient._id}')">
              Assign Doctor
            </button>
          </div>
        `).join("");
      } catch (error) {
        console.error(error);
        box.innerHTML = "<p>Could not load doctors or patients.</p>";
      }
    }

    async function assignDoctor(patientId) {
      const doctorId = document.getElementById(`doctor-${patientId}`).value;

      if (!doctorId) {
        alert("Please select a doctor.");
        return;
      }

      const response = await fetch("/api/admin/assign-doctor", {
        method: "PATCH",
        headers: {
          "Content-Type": "application/json",
          "Authorization": `Bearer ${token}`
        },
        body: JSON.stringify({ patientId, doctorId })
      });

      const data = await response.json().catch(() => ({}));

      if (!response.ok) {
        alert(data.message || "Could not assign doctor.");
        return;
      }

      alert("Patient assigned to doctor successfully.");
      loadDoctorsAndPatients();
    }

    async function loadSettings() {
      const result = document.getElementById("settingsResult");
      result.innerHTML = "<p class='muted'>Loading settings...</p>";

      try {
        const response = await fetch("/api/admin/settings", {
          headers: authHeaders()
        });

        const settings = await response.json();

        if (!response.ok) {
          result.innerHTML = "<p>Could not load settings.</p>";
          return;
        }

        document.getElementById("visitingHoursStart").value = settings.visitingHoursStart || "";
        document.getElementById("visitingHoursEnd").value = settings.visitingHoursEnd || "";
        document.getElementById("visitorLimitPerPatient").value = settings.visitorLimitPerPatient || "";
        document.getElementById("visitDurationMinutes").value = settings.visitDurationMinutes || "";
        document.getElementById("timeSlots").value = (settings.timeSlots || []).join("\n");
        const allowedDays = settings.allowedVisitingDays || [0, 1, 2, 3, 4, 5, 6];
        Array.from(document.getElementById("allowedVisitingDays").options).forEach(option => {
          option.selected = allowedDays.includes(Number(option.value));
        });
        document.getElementById("emergencyRestrictionsEnabled").checked = Boolean(settings.emergencyRestrictionsEnabled);
        document.getElementById("emergencyRestrictionMessage").value = settings.emergencyRestrictionMessage || "";

        result.innerHTML = "<p>Settings loaded.</p>";
      } catch (error) {
        console.error(error);
        result.innerHTML = "<p>Could not load settings.</p>";
      }
    }

    async function saveSettings() {
      const result = document.getElementById("settingsResult");
      const timeSlots = document.getElementById("timeSlots").value
        .split("\n")
        .map(slot => slot.trim())
        .filter(Boolean);
      const allowedVisitingDays = Array.from(document.getElementById("allowedVisitingDays").selectedOptions)
        .map(option => Number(option.value));

      try {
        const response = await fetch("/api/admin/settings", {
          method: "PUT",
          headers: {
            "Content-Type": "application/json",
            "Authorization": `Bearer ${token}`
          },
          body: JSON.stringify({
            visitingHoursStart: document.getElementById("visitingHoursStart").value,
            visitingHoursEnd: document.getElementById("visitingHoursEnd").value,
            visitorLimitPerPatient: document.getElementById("visitorLimitPerPatient").value,
            visitDurationMinutes: document.getElementById("visitDurationMinutes").value,
            timeSlots,
            allowedVisitingDays,
            emergencyRestrictionsEnabled: document.getElementById("emergencyRestrictionsEnabled").checked,
            emergencyRestrictionMessage: document.getElementById("emergencyRestrictionMessage").value.trim()
          })
        });

        const data = await response.json();

        if (!response.ok) {
          result.innerHTML = `<p>${data.message || "Could not save settings."}</p>`;
          return;
        }

        result.innerHTML = "<p>Settings saved.</p>";
      } catch (error) {
        console.error(error);
        result.innerHTML = "<p>Could not save settings.</p>";
      }
    }

    async function loadSystemActivity() {
      const activityBox = document.getElementById("activityBox");
      activityBox.innerHTML = "<p class='muted'>Loading activity...</p>";

      try {
        const response = await fetch("/api/admin/system-activity", {
          headers: authHeaders()
        });

        const activity = await response.json();

        if (!response.ok) {
          activityBox.innerHTML = "<p>Could not load activity.</p>";
          return;
        }

        activityBox.innerHTML = `
          <div class="card">
            <h4>Latest Users</h4>
            ${(activity.latestUsers || []).map(user => `
              <p>${user.fullName} (${user.role}) - ${user.email}</p>
            `).join("") || "<p>No recent users.</p>"}
            <h4 class="activity-subtitle">Latest Requests</h4>
            ${(activity.latestRequests || []).map(req => `
              <p>${req.visitorName} to ${req.patientName}: ${req.status}</p>
            `).join("") || "<p>No recent requests.</p>"}
          </div>
        `;
      } catch (error) {
        console.error(error);
        activityBox.innerHTML = "<p>Could not load activity.</p>";
      }
    }

    function printActivityPdf() {
      const from = document.getElementById("activityFromDate").value;
      const to = document.getElementById("activityToDate").value;

      if (!from || !to) {
        alert("Please select both From and To dates.");
        return;
      }

      if (from > to) {
        alert("From date must be before or equal to To date.");
        return;
      }

      downloadAdminPdf(
        `/api/admin/system-activity/export-pdf?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`,
        "medivisit-system-activity-report.pdf"
      );
    }

    function updateComplaintTabs(status) {
      const tabMap = {
        Open: "complaintsTabOpen",
        "In Progress": "complaintsTabInProgress",
        Resolved: "complaintsTabResolved"
      };

      Object.entries(tabMap).forEach(([tabStatus, id]) => {
        const button = document.getElementById(id);
        if (!button) return;
        button.classList.toggle("approve-btn", tabStatus === status);
        button.classList.toggle("secondary-btn", tabStatus !== status);
      });
    }

    async function loadComplaints(status = activeComplaintStatus) {
      activeComplaintStatus = status || "Open";
      updateComplaintTabs(activeComplaintStatus);
      const complaintList = document.getElementById("complaintList");
      complaintList.innerHTML = "<p class='muted'>Loading complaints...</p>";

      try {
        const response = await fetch("/api/admin/complaints", {
          headers: authHeaders()
        });

        const complaints = await response.json();

        if (!response.ok) {
          complaintList.innerHTML = "<p>Could not load complaints.</p>";
          return;
        }

        renderComplaints(complaints.filter(complaint => complaint.status === activeComplaintStatus));
      } catch (error) {
        console.error(error);
        complaintList.innerHTML = "<p>Could not load complaints.</p>";
      }
    }

    function renderComplaints(complaints) {
      const complaintList = document.getElementById("complaintList");

      if (complaints.length === 0) {
        complaintList.innerHTML = "<p>No complaints submitted.</p>";
        return;
      }

      complaintList.innerHTML = complaints.map(complaint => `
        <div class="card">
          <p><strong>From:</strong> ${complaint.userName}</p>
          <p><strong>Email:</strong> ${complaint.userEmail}</p>
          <p><strong>Role:</strong> ${complaint.userRole}</p>
          <p><strong>Subject:</strong> ${complaint.subject}</p>
          <p><strong>Complaint:</strong> ${complaint.message}</p>
          <p><strong>Status:</strong> ${complaint.status}</p>
          <p><strong>Submitted At:</strong> ${new Date(complaint.createdAt).toLocaleString()}</p>
          ${complaint.adminReply ? `<p><strong>Admin Reply:</strong> ${complaint.adminReply}</p>` : ""}
          ${complaint.repliedAt ? `<p><strong>Replied At:</strong> ${new Date(complaint.repliedAt).toLocaleString()}</p>` : ""}
          ${complaint.status !== "Resolved" ? `
            <textarea id="reply-${complaint._id}" rows="3" placeholder="Reply to complaint">${complaint.adminReply || ""}</textarea>
            <select id="status-${complaint._id}">
              <option value="Open" ${complaint.status === "Open" ? "selected" : ""}>Open</option>
              <option value="In Progress" ${complaint.status === "In Progress" ? "selected" : ""}>In Progress</option>
              <option value="Resolved" ${complaint.status === "Resolved" ? "selected" : ""}>Resolved</option>
            </select>
            <button type="button" class="action-btn approve-btn" data-action-code="replyToComplaint('${complaint._id}')">
              Send Reply / Update
            </button>
            <div id="complaint-reply-message-${complaint._id}"></div>
          ` : ""}
        </div>
      `).join("");
    }

    async function replyToComplaint(complaintId) {
      const adminReply = document.getElementById(`reply-${complaintId}`).value.trim();
      const status = document.getElementById(`status-${complaintId}`).value;

      if (!adminReply) {
        alert("Please enter a reply before sending.");
        return;
      }

      try {
        const response = await fetch(`/api/admin/complaints/${complaintId}/reply`, {
          method: "PATCH",
          headers: {
            "Content-Type": "application/json",
            "Authorization": `Bearer ${token}`
          },
          body: JSON.stringify({ adminReply, status })
        });
        const data = await response.json();

        if (!response.ok) {
          alert(data.message || "Could not save complaint reply.");
          return;
        }

        alert("Complaint reply saved.");
        loadComplaints(activeComplaintStatus);
      } catch (error) {
        console.error(error);
        alert("Could not save complaint reply.");
      }
    }

    async function loadProfile() {
      const response = await fetch("/api/auth/me", {
        headers: authHeaders()
      });
      const profile = await response.json();
      if (!response.ok) {
        document.getElementById("profileMessage").innerHTML = "<p>Could not load profile.</p>";
        return;
      }
      document.getElementById("profileFullName").value = profile.fullName || "";
      document.getElementById("profileEmail").value = profile.email || "";
      document.getElementById("profileBirthDate").value = formatDateForInput(profile.birthDate);
      document.getElementById("profileAddress").value = profile.address || "";
      document.getElementById("profilePhotoPreview").innerHTML = profile.photo ? `<img src="${profile.photo}" alt="Profile photo" class="profile-photo-preview-img">` : "<p class='muted'>No photo uploaded.</p>";
      const deleteButton = document.getElementById("deleteAccountBtn");
      if (deleteButton) deleteButton.classList.toggle("hidden", profile.email === "admin@hospital.com" || profile.isMainAdmin === true);
    }

    async function deleteMyAccount() {
      if (!confirm("Are you sure you want to delete your account? This action cannot be undone.")) return;

      try {
        const response = await fetch("/api/account/me", {
          method: "DELETE",
          headers: authHeaders()
        });
        const data = await response.json();

        if (!response.ok) {
          throw new Error(data.message || "Could not delete account.");
        }

        alert(data.message || "Your account has been deleted. It may take up to 24 hours before you can register again.");
        clearSessionAndRedirect();
      } catch (error) {
        document.getElementById("profileMessage").innerHTML = `<p>${error.message || "Could not delete account."}</p>`;
      }
    }

    document.getElementById("profileForm").addEventListener("submit", async function(e) {
      e.preventDefault();
      const response = await fetch("/api/auth/profile", {
        method: "PATCH",
        headers: {
          "Content-Type": "application/json",
          "Authorization": `Bearer ${token}`
        },
        body: JSON.stringify({
          fullName: document.getElementById("profileFullName").value.trim(),
          birthDate: document.getElementById("profileBirthDate").value,
          address: document.getElementById("profileAddress").value.trim()
        })
      });
      const data = await response.json();
      document.getElementById("profileMessage").innerHTML = `<p>${data.message || (response.ok ? "Profile updated." : "Could not update profile.")}</p>`;
      if (response.ok) localStorage.setItem("currentUser", JSON.stringify(data.user));
    });

    loadUsers();
    loadSettings();
