const currentUser = JSON.parse(localStorage.getItem("currentUser"));
    const token = localStorage.getItem("token");
    let hospitalSettings = null;
    let statusCheckTimeouts = [];
    let visitRequestEvents = null;
    const statusStorageKey = `visitorLatestRequest:${currentUser?.id || currentUser?._id || "current"}`;
    const cancelledNoticeKey = `visitorCancelledNoticeShown:${currentUser?.id || currentUser?._id || "current"}`;

    if (!currentUser || currentUser.role !== "visitor") {
      window.location.href = "/login.html";
    }

    localStorage.removeItem(cancelledNoticeKey);

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

    function showMessage(elementId, message, type = "success") {
      document.getElementById(elementId).innerHTML = `<div class="result ${type}">${message}</div>`;
    }

    function clearElement(id) {
      const element = document.getElementById(id);
      if (element) element.innerHTML = "";
    }

    function setVisitInputsVisible(visible) {
      ["visitDate", "visitTimeSlot", "reason", "submitBtn"].forEach(id => {
        const element = document.getElementById(id);
        if (element) element.classList.toggle("hidden", !visible);
      });
    }

    function clearPatientSearchState() {
      document.getElementById("patientId").value = "";
      document.getElementById("patientName").value = "";
      document.getElementById("patientResult").textContent = "";
      document.getElementById("patientResult").className = "";
      document.getElementById("submitBtn").disabled = true;
      setVisitInputsVisible(true);
    }

    function resetVisitForm() {
      const form = document.getElementById("visitForm");
      form.reset();
      form.classList.remove("hidden");
      clearPatientSearchState();
    }

    function clearTemporaryMessages() {
      ["dashboardMessage", "patientResult", "profileMessage", "complaintMessage", "myComplaintsList"].forEach(id => {
        const element = document.getElementById(id);
        if (!element) return;
        element.textContent = "";
        element.className = "";
        if (id !== "patientResult") element.innerHTML = "";
      });
    }

    function clearStatusChecks() {
      statusCheckTimeouts.forEach(timeoutId => clearTimeout(timeoutId));
      statusCheckTimeouts = [];
    }

    function closeVisitRequestStream() {
      if (visitRequestEvents) {
        visitRequestEvents.close();
        visitRequestEvents = null;
      }
    }

    function monitorPendingRequest() {
      const remembered = getRememberedRequest();
      if (!remembered || remembered.status !== "Pending") return;
      if (visitRequestEvents) return;

      if (typeof EventSource === "undefined") {
        scheduleLimitedStatusChecks();
        return;
      }

      scheduleLimitedStatusChecks();
      visitRequestEvents = new EventSource(`/api/visit-requests/my-latest/events?token=${encodeURIComponent(token)}`);

      visitRequestEvents.addEventListener("visit-request-updated", event => {
        const request = JSON.parse(event.data);
        if (!request) return;

        renderVisitorDashboardState(request, "Visit status updated.");

        if (isFinalStatus(request.status)) {
          closeVisitRequestStream();
          clearStatusChecks();
        }
      });

      visitRequestEvents.onerror = () => {
        closeVisitRequestStream();
        const latest = getRememberedRequest();
        if (latest?.status === "Pending") scheduleLimitedStatusChecks();
      };
    }

    function rememberLatestRequest(request) {
      if (!request || !request._id) return;
      localStorage.setItem(statusStorageKey, JSON.stringify({
        id: request._id,
        status: request.status,
        passCode: request.passCode || "",
        updatedAt: request.updatedAt || request.createdAt || new Date().toISOString()
      }));
    }

    function getRememberedRequest() {
      try {
        return JSON.parse(localStorage.getItem(statusStorageKey) || "null");
      } catch (error) {
        return null;
      }
    }

    function isApprovedStatus(status) {
      return ["Approved by Patient", "Approved by Doctor", "Approved by Security"].includes(status);
    }

    function hasShownCancelledNotice(requestId) {
      return localStorage.getItem(cancelledNoticeKey) === requestId;
    }

    function markCancelledNoticeShown(requestId) {
      if (requestId) localStorage.setItem(cancelledNoticeKey, requestId);
    }

    function isFinalStatus(status) {
      return isApprovedStatus(status) || ["Rejected by Patient", "Rejected by Doctor", "Cancelled", "Expired", "Exited", "Completed"].includes(status);
    }

    function todayString() {
      const now = new Date();
      const month = String(now.getMonth() + 1).padStart(2, "0");
      const day = String(now.getDate()).padStart(2, "0");
      return `${now.getFullYear()}-${month}-${day}`;
    }

    async function loadHospitalSettings() {
      const slotSelect = document.getElementById("visitTimeSlot");
      const form = document.getElementById("visitForm");
      document.getElementById("visitDate").min = todayString();

      try {
        const response = await fetch("/api/hospital-settings", { headers: authHeaders(false) });
        hospitalSettings = await response.json();

        if (!response.ok) {
          slotSelect.innerHTML = '<option value="">Could not load time slots</option>';
          return;
        }

        if (hospitalSettings.emergencyRestrictionsEnabled) {
          form.classList.add("hidden");
          showMessage("dashboardMessage", hospitalSettings.emergencyRestrictionMessage || "Emergency visitor restrictions are active. New visit requests are blocked.", "warning");
          return;
        }

        const slots = hospitalSettings.timeSlots || [];
        if (slots.length === 0) {
          slotSelect.innerHTML = '<option value="">No time slots available</option>';
          showMessage("dashboardMessage", "No hospital time slots are currently available. Please contact admin.", "warning");
          document.getElementById("submitBtn").disabled = true;
          return;
        }

        slotSelect.innerHTML = '<option value="">Select time slot</option>' + slots.map(slot => `<option value="${slot}">${slot}</option>`).join("");
      } catch (error) {
        console.error(error);
        slotSelect.innerHTML = '<option value="">Could not load time slots</option>';
      }
    }

    function renderPass(current) {
      const currentPass = document.getElementById("currentPass");
      const qrUrl = `https://api.qrserver.com/v1/create-qr-code/?size=220x220&data=${encodeURIComponent(current.passCode)}`;

      currentPass.innerHTML = `
          <img class="qr-code" src="${qrUrl}" alt="QR code for pass ${current.passCode}" />
          <p class="pass-code">${current.passCode}</p>
          <p><strong>Patient:</strong> ${current.patientName}</p>
          <p><strong>Date:</strong> ${current.visitDate}</p>
          <p><strong>Time Slot:</strong> ${current.visitTimeSlot || "Not recorded"}</p>
          <p><strong>Status:</strong> ${current.status}</p>
          <p><strong>Expires:</strong> ${current.expiresAt ? new Date(current.expiresAt).toLocaleString() : "End of visit day"}</p>
          <button type="button" class="reject" data-action-code="cancelVisit('${current._id}')">Cancel Approved Visit</button>
        `;
    }

    function renderVisitorDashboardState(request, messagePrefix = "", options = {}) {
      if (!request) {
        showPanel("visitRequestPanel", false);
        return;
      }

      const previousRequest = getRememberedRequest();
      rememberLatestRequest(request);

      if (isApprovedStatus(request.status) && request.passCode) {
        closeVisitRequestStream();
        clearStatusChecks();
        renderPass(request);
        showPanel("currentPassPanel", false);
        showMessage("dashboardMessage", `${messagePrefix || "Visit approved."} Your QR/pass is ready.`, "success");
        return;
      }

      showPanel("visitRequestPanel", false);

      if (request.status === "Pending") {
        showMessage("dashboardMessage", "Your visit request is pending patient approval.", "warning");
        monitorPendingRequest();
      } else if (request.status === "Cancelled") {
        closeVisitRequestStream();
        clearStatusChecks();
        localStorage.removeItem(statusStorageKey);
        markCancelledNoticeShown(request._id);
        clearElement("dashboardMessage");
      } else if (request.status === "Expired") {
        closeVisitRequestStream();
        clearStatusChecks();
        localStorage.removeItem(statusStorageKey);
        clearElement("dashboardMessage");
      } else if (request.status === "Exited" || request.status === "Completed") {
        closeVisitRequestStream();
        clearStatusChecks();
        localStorage.removeItem(statusStorageKey);
        showMessage("dashboardMessage", "Your visit has been checked out. You can create a new request.", "success");
      } else if (request.status && request.status.includes("Rejected")) {
        closeVisitRequestStream();
        clearStatusChecks();
        localStorage.removeItem(statusStorageKey);
        showMessage("dashboardMessage", `Your visit request was rejected (${request.status}).`, "error");
      }
    }

    async function loadCurrentPass(showWhenFound = true) {
      const currentPass = document.getElementById("currentPass");
      currentPass.innerHTML = "<p>Loading current QR...</p>";

      try {
        const response = await fetch("/api/visit-requests/my-passes", { headers: authHeaders(false) });
        const passes = await response.json();

        if (!response.ok) {
          currentPass.innerHTML = "<p>Could not load current QR.</p>";
          return;
        }

        const current = passes.find(pass => pass.passCode && !["Expired", "Cancelled"].includes(pass.status));

        if (!current) {
          currentPass.innerHTML = "<p>No approved active QR pass yet.</p>";
          return;
        }

        rememberLatestRequest(current);
        renderPass(current);

        if (showWhenFound && !document.getElementById("visitRequestPanel").classList.contains("hidden")) {
          showPanel("currentPassPanel", false);
        }
      } catch (error) {
        console.error(error);
        currentPass.innerHTML = "<p>Could not load current QR.</p>";
      }
    }

    async function fetchLatestRequest() {
      const response = await fetch("/api/visit-requests/my-latest", { headers: authHeaders(false) });
      const data = await response.json().catch(() => ({}));

      if (!response.ok) {
        return null;
      }

      return data.visitRequest || null;
    }

    async function checkRequestStatus({ showUnchanged = false } = {}) {
      const latest = await fetchLatestRequest();
      if (!latest) return null;

      const remembered = getRememberedRequest();
      const changed = !remembered || remembered.id !== latest._id || remembered.status !== latest.status || remembered.passCode !== (latest.passCode || "");
      rememberLatestRequest(latest);

      if (changed || showUnchanged || isApprovedStatus(latest.status)) {
        renderVisitorDashboardState(latest, changed ? "Visit status updated." : "");
      }

      return latest;
    }

    function scheduleLimitedStatusChecks() {
      clearStatusChecks();
      [5000, 10000, 20000, 30000, 45000, 60000].forEach(delay => {
        const timeoutId = setTimeout(async () => {
          const latest = await checkRequestStatus();
          if (latest && isFinalStatus(latest.status)) clearStatusChecks();
        }, delay);
        statusCheckTimeouts.push(timeoutId);
      });
    }

    async function cancelVisit(id) {
      const response = await fetch(`/api/visit-requests/${id}/cancel`, {
        method: "PATCH",
        headers: authHeaders()
      });
      const data = await response.json().catch(() => ({}));

      if (!response.ok) {
        showMessage("currentPass", data.message || "Could not cancel visit.", "error");
        return;
      }

      clearElement("dashboardMessage");
      markCancelledNoticeShown(id);
      resetVisitForm();
      document.getElementById("currentPass").innerHTML = "<p>No approved active QR pass yet.</p>";
      localStorage.removeItem(statusStorageKey);
      showPanel("visitRequestPanel", false);
    }

    async function checkPatient() {
      const patientCode = document.getElementById("patientCode").value.trim().toUpperCase();
      const result = document.getElementById("patientResult");
      const patientIdInput = document.getElementById("patientId");
      const patientNameInput = document.getElementById("patientName");
      const checkingButton = document.getElementById("checkingButton");
      const submitBtn = document.getElementById("submitBtn");

      patientIdInput.value = "";
      patientNameInput.value = "";
      submitBtn.disabled = true;
      setVisitInputsVisible(true);
      checkingButton.disabled = true;
      clearElement("dashboardMessage");
      localStorage.removeItem(cancelledNoticeKey);

      if (patientCode.length < 4) {
        result.className = "error";
        result.textContent = "Please enter the patient visitor code.";
        checkingButton.disabled = false;
        return;
      }

      try {
        const response = await fetch(`/api/patients/check?code=${encodeURIComponent(patientCode)}`);
        const data = await response.json();

        if (!response.ok || !data.exists) {
          result.className = "error";
          result.textContent = data.message || "Patient not found.";
          return;
        }

        patientIdInput.value = data.patient._id;
        patientNameInput.value = data.patient.fullName;
        const isRestricted = data.patient.visitEligibilityStatus === "Not Eligible" && Boolean((data.patient.restrictionNote || "").trim());

        if (isRestricted) {
          result.className = "warning";
          result.textContent = `The patient is currently restricted by their doctor. Please try again later. Reason: ${data.patient.restrictionNote}`;
          submitBtn.disabled = true;
          setVisitInputsVisible(false);
          return;
        }

        result.className = data.patient.visitEligibilityStatus === "Not Eligible" ? "warning" : "success";
        result.textContent = `Patient found: ${data.patient.fullName}. Eligibility: ${data.patient.visitEligibilityStatus}.`;
        submitBtn.disabled = data.patient.visitEligibilityStatus === "Not Eligible";
        setVisitInputsVisible(true);
      } catch (error) {
        console.error(error);
        result.className = "error";
        result.textContent = "Error checking patient.";
      } finally {
        checkingButton.disabled = false;
      }
    }

    document.getElementById("patientCode").addEventListener("input", function() {
      clearPatientSearchState();
      clearElement("dashboardMessage");
      localStorage.removeItem(cancelledNoticeKey);
    });

    document.getElementById("visitForm").addEventListener("submit", async function(e) {
      e.preventDefault();
      const patientResult = document.getElementById("patientResult");
      if (patientResult.className === "warning" && patientResult.textContent.includes("restricted by their doctor")) {
        showMessage("dashboardMessage", "The patient is currently restricted by their doctor. Please try again later.", "warning");
        return;
      }

      const visitDate = document.getElementById("visitDate").value;
      const selectedDate = new Date(`${visitDate}T00:00:00`);
      clearElement("dashboardMessage");

      if (visitDate < todayString()) {
        showMessage("dashboardMessage", "Visitors cannot select past dates.", "error");
        return;
      }

      if (hospitalSettings && hospitalSettings.allowedVisitingDays && !hospitalSettings.allowedVisitingDays.includes(selectedDate.getDay())) {
        showMessage("dashboardMessage", "The selected date is outside the hospital's allowed visiting days.", "error");
        return;
      }

      try {
        const response = await fetch("/api/visit-requests", {
          method: "POST",
          headers: authHeaders(),
          body: JSON.stringify({
            patientName: document.getElementById("patientName").value,
            patientVisitorCode: document.getElementById("patientCode").value.trim().toUpperCase(),
            visitDate,
            visitTimeSlot: document.getElementById("visitTimeSlot").value,
            reason: document.getElementById("reason").value.trim()
          })
        });
        const data = await response.json();

        if (!response.ok) {
          showMessage("dashboardMessage", data.message || "Could not submit visit request.", "error");
          return;
        }

        resetVisitForm();
        localStorage.removeItem(cancelledNoticeKey);
        rememberLatestRequest(data.visitRequest);
        renderVisitorDashboardState(data.visitRequest);
        showMessage("dashboardMessage", "Visit request submitted successfully. Waiting for patient approval.", "success");
      } catch (error) {
        console.error(error);
        showMessage("dashboardMessage", "Could not submit visit request.", "error");
      }
    });

    async function loadHistory() {
      const box = document.getElementById("historyList");
      box.innerHTML = "<p>Loading history...</p>";
      const response = await fetch("/api/visit-requests/my", { headers: authHeaders(false) });
      const requests = await response.json();
      if (!response.ok) {
        box.innerHTML = "<p>Could not load history.</p>";
        return;
      }
      box.innerHTML = requests.length ? requests.map(req => `
        <div class="card">
          <p><strong>Patient:</strong> ${req.patientName}</p>
          <p><strong>Date:</strong> ${req.visitDate}</p>
          <p><strong>Time Slot:</strong> ${req.visitTimeSlot || "Not recorded"}</p>
          <p><strong>Reason:</strong> ${req.reason}</p>
          <p><strong>Status:</strong> ${req.status}</p>
          ${req.passCode ? `<p><strong>Pass Code:</strong> ${req.passCode}</p>` : ""}
        </div>
      `).join("") : "<p>No requests submitted yet.</p>";
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
      if (!response.ok) {
        showMessage("profileMessage", data.message || "Could not update profile.", "error");
        return;
      }
      localStorage.setItem("currentUser", JSON.stringify(data.user));
      showMessage("profileMessage", "Profile updated successfully.", "success");
    });

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
    function showPanel(panelId, close = true) {
      document.querySelectorAll(".section").forEach(section => section.classList.add("hidden"));
      document.getElementById(panelId).classList.remove("hidden");
      if (close) closeMenu();
    }
    function refreshDashboard() {
      closeMenu();
      clearStatusChecks();
      clearTemporaryMessages();
      resetVisitForm();
      localStorage.removeItem(cancelledNoticeKey);
      clearElement("historyList");
      clearElement("profileMessage");
      clearElement("complaintMessage");
      document.getElementById("complaintForm").reset();
      document.getElementById("currentPass").innerHTML = "";
      showPanel("visitRequestPanel", false);
      loadHospitalSettings();
      checkRequestStatus({ showUnchanged: true }).then(latest => {
        if (!latest || !isApprovedStatus(latest.status)) loadCurrentPass(false);
      });
    }

    loadHospitalSettings();
    checkRequestStatus({ showUnchanged: true }).then(latest => {
      if (!latest || !isApprovedStatus(latest.status)) loadCurrentPass(false);
    });
    window.addEventListener("focus", () => {
      checkRequestStatus();
    });
