const currentUser = JSON.parse(localStorage.getItem("currentUser"));
    const token = localStorage.getItem("token");
    if (!currentUser || currentUser.role !== "visitor") {
      window.location.href = "/login.html";
    }

    const passInfo = document.getElementById("passInfo");

    function authHeaders() {
      return {
        "Authorization": `Bearer ${token}`
      };
    }

    async function loadPass() {
      const params = new URLSearchParams(window.location.search);
      const passCodeFromUrl = params.get("passCode");

      try {
        const response = await fetch("/api/visit-requests/my-passes", {
          headers: authHeaders()
        });

        const approvedRequests = await response.json();

        if (!response.ok) {
          passInfo.innerHTML = '<p class="message">Could not load approved visitor pass.</p>';
          return;
        }

        const selectedRequest = passCodeFromUrl
          ? approvedRequests.find(req => req.passCode === passCodeFromUrl)
          : approvedRequests[0];

        if (!selectedRequest) {
          passInfo.innerHTML = '<p class="message">No approved visitor pass found.</p>';
          return;
        }

        renderPass(selectedRequest);
      } catch (error) {
        console.error(error);
        passInfo.innerHTML = '<p class="message">Could not load approved visitor pass.</p>';
      }
    }

    function renderPass(selectedRequest) {
      const passCode = selectedRequest.passCode;
      const qrUrl = `https://api.qrserver.com/v1/create-qr-code/?size=220x220&data=${encodeURIComponent(passCode)}`;

      passInfo.innerHTML = `
        <img class="qr-code" src="${qrUrl}" alt="QR code for pass ${passCode}" />
        <p class="pass-code">${passCode}</p>
        <p><strong>Patient:</strong> ${selectedRequest.patientName}</p>
        <p><strong>Date:</strong> ${selectedRequest.visitDate}</p>
        <p><strong>Time Slot:</strong> ${selectedRequest.visitTimeSlot || "Not recorded"}</p>
        <p><strong>Reason:</strong> ${selectedRequest.reason}</p>
        <p><strong>Status:</strong> ${selectedRequest.status}</p>
      `;
    }

    loadPass();
