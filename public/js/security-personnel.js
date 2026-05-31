const currentUser = JSON.parse(localStorage.getItem("currentUser"));
    const token = localStorage.getItem("token");
    if (!currentUser || currentUser.role !== "security") window.location.href = "/login.html";
    let qrScanner = null;
    let scanLocked = false;
    const countdownTimers = new Map();

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
    function setCameraStatus(message) { document.getElementById("cameraStatus").textContent = message; }
    function showMessage(id, message, type = "success") { document.getElementById(id).innerHTML = `<div class="result ${type}">${message}</div>`; }

    function clearCountdownTimers() {
      countdownTimers.forEach(timerId => clearTimeout(timerId));
      countdownTimers.clear();
    }

    function clearSecurityDashboard() {
      document.getElementById("passCode").value = "";
      document.getElementById("scanResult").innerHTML = "";
      document.getElementById("currentCheckinsList").innerHTML = "";
      document.getElementById("checkoutHistoryList").innerHTML = "";
      document.getElementById("profileMessage").innerHTML = "";
      document.getElementById("profilePhotoPreview").innerHTML = "";
      document.getElementById("complaintMessage").innerHTML = "";
      document.getElementById("myComplaintsList").innerHTML = "";
      const profileForm = document.getElementById("profileForm");
      if (profileForm) profileForm.reset();
      clearCountdownTimers();
      setCameraStatus("Camera scanner is not running.");
    }

    async function startScanner() {
      if (typeof Html5Qrcode === "undefined") {
        setCameraStatus("QR scanner library could not load. Please enter the pass code manually.");
        return;
      }
      try {
        await stopScanner(false);
        scanLocked = false;
        qrScanner = new Html5Qrcode("qrReader");
        setCameraStatus("QR scanner is running. Point it at the visitor QR code.");
        await qrScanner.start({ facingMode: "environment" }, { fps: 10, qrbox: { width: 250, height: 250 } }, onQrScanSuccess, function() {});
      } catch (error) {
        console.error(error);
        setCameraStatus("Could not start QR scanner. Allow camera access or enter the pass code manually.");
      }
    }
    async function onQrScanSuccess(decodedText) {
      if (scanLocked) return;
      scanLocked = true;
      const passCode = getPassCodeFromScan(decodedText);
      document.getElementById("passCode").value = passCode;
      await stopScanner(false);
      verifyPass(passCode);
    }
    async function stopScanner(showStoppedMessage = true) {
      scanLocked = false;
      if (qrScanner) {
        try {
          if (qrScanner.isScanning) await qrScanner.stop();
          await qrScanner.clear();
        } catch (error) {
          console.error(error);
        }
        qrScanner = null;
      }
      if (showStoppedMessage) setCameraStatus("Camera scanner is not running.");
    }
    function getPassCodeFromScan(value) {
      const scannedValue = (value || "").trim();
      try {
        const url = new URL(scannedValue);
        const passCodeFromUrl = url.searchParams.get("passCode");
        if (passCodeFromUrl) return passCodeFromUrl.trim().toUpperCase();
      } catch (error) {}
      const passCodeMatch = scannedValue.match(/PASS-[A-Z0-9]+/i);
      return passCodeMatch ? passCodeMatch[0].toUpperCase() : scannedValue.toUpperCase();
    }
    async function verifyPass(scannedPassCode) {
      const passCode = getPassCodeFromScan(scannedPassCode || document.getElementById("passCode").value);
      const scanResult = document.getElementById("scanResult");
      if (!passCode) {
        scanResult.innerHTML = '<p class="error">Please enter a pass code.</p>';
        return;
      }
      try {
        const response = await fetch("/api/security/check-pass", {
          method: "POST",
          headers: authHeaders(),
          body: JSON.stringify({ passCode })
        });
        const data = await response.json();
        if (!response.ok) {
          if (data.visit) renderValidPass(data.visit, data.message || "Pass cannot be used.");
          else scanResult.innerHTML = `<div class="result"><p class="error">${data.message || "Invalid pass code."}</p><p><strong>Scanned:</strong> ${passCode}</p></div>`;
          return;
        }
        renderValidPass(data.visit, data.message, data.exitRemainingSeconds);
      } catch (error) {
        console.error(error);
        scanResult.innerHTML = `<div class="result"><p class="error">Could not check pass code.</p><p><strong>Scanned:</strong> ${passCode}</p></div>`;
      }
    }
    function renderValidPass(req, message, remainingFromServer) {
      const isBlocked = ["Expired", "Cancelled", "Exited", "Completed"].includes(req.status) || req.exitedAt;
      const passMessage = message || (isBlocked ? `Pass ${req.status.toLowerCase()}.` : "Valid pass.");
      const remainingSeconds = getRemainingSeconds(req, remainingFromServer);
      document.getElementById("scanResult").innerHTML = `
        <div class="result">
          <p class="${isBlocked ? "error" : "success"}">${passMessage}</p>
          <p><strong>Visitor:</strong> ${req.visitorName}</p>
          <p><strong>Patient:</strong> ${req.patientName}</p>
          <p><strong>Date:</strong> ${req.visitDate}</p>
          <p><strong>Time Slot:</strong> ${req.visitTimeSlot || "Not recorded"}</p>
          <p><strong>Status:</strong> ${req.status}</p>
          <p><strong>Pass Code:</strong> ${req.passCode || "Inactive"}</p>
          <p><strong>Entry:</strong> ${req.verifiedBySecurity ? "Entered" : "Not entered"}</p>
          <p><strong>Exit:</strong> ${req.exitedAt ? "Exited" : "Not exited"}</p>
          ${req.securityApprovedAt ? `<p><strong>Check-in Time:</strong> ${new Date(req.securityApprovedAt).toLocaleString()}</p>` : ""}
          ${req.exitedAt ? `<p><strong>Exit Time:</strong> ${new Date(req.exitedAt).toLocaleString()}</p>` : ""}
          ${getVisitActionHtml(req, remainingSeconds, "scan")}
        </div>`;

      if (req.verifiedBySecurity && !req.exitedAt && !isBlocked && remainingSeconds > 0) {
        startExitCountdown(`scan-countdown-${req._id}`, req.passCode, remainingSeconds, () => renderValidPass(req, "Exit is now available.", 0));
      }
    }
    function getRemainingSeconds(req, remainingFromServer) {
      if (!req.securityApprovedAt) return null;
      if (Number.isFinite(Number(remainingFromServer))) return Math.max(0, Number(remainingFromServer));
      return Math.max(0, Math.ceil((new Date(req.securityApprovedAt).getTime() + 30000 - Date.now()) / 1000));
    }
    function getVisitActionHtml(req, remainingSeconds = null, countdownPrefix = "scan") {
      if (req.status === "Expired") return '<p class="error">Pass expired. Entry is not allowed.</p>';
      if (req.status === "Cancelled") return '<p class="error">Pass cancelled. Entry is not allowed.</p>';
      if (req.status === "Exited" || req.status === "Completed" || req.exitedAt) return '<p class="success">Visitor has already exited. This pass cannot be reused.</p>';
      if (!req.verifiedBySecurity) return `<button type="button" data-action-code="approvePass('${req.passCode}')">Approve</button>`;
      if (remainingSeconds > 0) return `<p class="warning" id="${countdownPrefix}-countdown-${req._id}">Exit available in ${remainingSeconds} seconds.</p>`;
      return `<p class="success">Approved by security. Visitor can exit when leaving.</p><button type="button" data-action-code="exitPass('${req.passCode}')">Exit</button>`;
    }
    async function approvePass(passCode) {
      const response = await fetch("/api/security/verify-pass", { method: "POST", headers: authHeaders(), body: JSON.stringify({ passCode }) });
      const data = await response.json().catch(() => ({}));
      if (!response.ok && !data.visit) {
        document.getElementById("scanResult").innerHTML = `<p class="error">${data.message || "Could not approve pass."}</p>`;
        return;
      }
      renderValidPass(data.visit, !response.ok ? data.message : undefined, data.exitRemainingSeconds);
      if (response.ok) loadCurrentCheckins();
    }
    async function exitPass(passCode) {
      const response = await fetch("/api/security/exit-pass", { method: "POST", headers: authHeaders(), body: JSON.stringify({ passCode }) });
      const data = await response.json().catch(() => ({}));
      if (!response.ok && !data.visit) {
        document.getElementById("scanResult").innerHTML = `<p class="error">${data.message || "Could not record exit."}</p>`;
        return;
      }
      renderValidPass(data.visit, !response.ok ? data.message : undefined, data.exitRemainingSeconds);
      if (response.ok) {
        loadCurrentCheckins();
        loadCheckoutHistory();
      }
    }
    function startExitCountdown(elementId, passCode, seconds, onComplete) {
      const existingTimer = countdownTimers.get(elementId);
      if (existingTimer) clearTimeout(existingTimer);

      const tick = remaining => {
        const element = document.getElementById(elementId);
        if (!element) return;
        if (remaining <= 0) {
          element.outerHTML = `<p class="success">Exit is now available.</p><button type="button" data-action-code="exitPass('${passCode}')">Exit</button>`;
          countdownTimers.delete(elementId);
          if (onComplete) onComplete();
          return;
        }
        element.textContent = `Exit available in ${remaining} seconds.`;
        const timerId = setTimeout(() => tick(remaining - 1), 1000);
        countdownTimers.set(elementId, timerId);
      };

      tick(seconds);
    }
    async function loadCurrentCheckins() {
      const box = document.getElementById("currentCheckinsList");
      box.innerHTML = "<p>Loading current check-ins...</p>";
      const response = await fetch("/api/security/current-checkins", { headers: authHeaders(false) });
      const visits = await response.json();
      if (!response.ok) {
        box.innerHTML = "<p>Could not load current check-ins.</p>";
        return;
      }
      box.innerHTML = visits.length ? visits.map(req => `
        <div class="card">
          <p><strong>Visitor:</strong> ${req.visitorName}</p>
          <p><strong>Patient:</strong> ${req.patientName}</p>
          <p><strong>Pass Code:</strong> ${req.passCode || "Inactive"}</p>
          <p><strong>Check-in Time:</strong> ${req.securityApprovedAt ? new Date(req.securityApprovedAt).toLocaleString() : "Not checked in"}</p>
          <p><strong>Visit Date:</strong> ${req.visitDate}</p>
          <p><strong>Time Slot:</strong> ${req.visitTimeSlot || "Not recorded"}</p>
          <p><strong>Status:</strong> ${req.status}</p>
          ${getVisitActionHtml(req, getRemainingSeconds(req, req.exitRemainingSeconds), "current")}
        </div>
      `).join("") : "<p>No visitors are currently checked in.</p>";

      visits.forEach(req => {
        const remainingSeconds = getRemainingSeconds(req, req.exitRemainingSeconds);
        if (remainingSeconds > 0) startExitCountdown(`current-countdown-${req._id}`, req.passCode, remainingSeconds, null);
      });
    }
    async function loadCheckoutHistory() {
      const box = document.getElementById("checkoutHistoryList");
      box.innerHTML = "<p>Loading check-out history...</p>";
      const response = await fetch("/api/security/checkout-history", { headers: authHeaders(false) });
      const visits = await response.json();
      if (!response.ok) {
        box.innerHTML = "<p>Could not load check-out history.</p>";
        return;
      }
      box.innerHTML = visits.length ? visits.map(req => `
        <div class="card">
          <p><strong>Visitor:</strong> ${req.visitorName}</p>
          <p><strong>Patient:</strong> ${req.patientName}</p>
          <p><strong>Pass Code:</strong> ${req.passCode || "Inactive"}</p>
          <p><strong>Check-in Time:</strong> ${req.securityApprovedAt ? new Date(req.securityApprovedAt).toLocaleString() : "Not checked in"}</p>
          <p><strong>Check-out Time:</strong> ${req.exitedAt ? new Date(req.exitedAt).toLocaleString() : "Not recorded"}</p>
          <p><strong>Visit Date:</strong> ${req.visitDate}</p>
          <p><strong>Time Slot:</strong> ${req.visitTimeSlot || "Not recorded"}</p>
          <p><strong>Final Status:</strong> ${req.status}</p>
        </div>
      `).join("") : "<p>No checked-out visitors yet.</p>";
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
    function toggleMenu() { document.getElementById("dashboardMenu").classList.toggle("open"); }
    function closeMenu() { document.getElementById("dashboardMenu").classList.remove("open"); }
    function showPanel(panelId) {
      document.querySelectorAll(".section").forEach(section => section.classList.add("hidden"));
      document.getElementById(panelId).classList.remove("hidden");
      closeMenu();
    }
    async function refreshDashboard() {
      closeMenu();
      await stopScanner(false);
      clearSecurityDashboard();
      showPanel("scannerPanel");
    }
    window.addEventListener("beforeunload", function() { stopScanner(false); });
    document.addEventListener("click", function(e) { if (!e.target.closest(".menu-wrap")) closeMenu(); });
