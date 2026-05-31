const currentUser = JSON.parse(localStorage.getItem("currentUser"));
    const token = localStorage.getItem("token");

    if (!currentUser || currentUser.role !== "visitor") {
      window.location.href = "/login.html";
    }

    function logout() {
      localStorage.removeItem("currentUser");
      localStorage.removeItem("token");
      window.location.href = "/login.html";
    }

    function authHeaders() {
      return {
        "Authorization": `Bearer ${token}`
      };
    }

    function toggleMenu() {
      document.getElementById("historyMenu").classList.toggle("open");
    }

    function refreshHistory() {
      document.getElementById("historyMenu").classList.remove("open");
      document.getElementById("requestList").innerHTML = "";
      loadRequests();
    }

    async function loadRequests() {
      const requestList = document.getElementById("requestList");
      requestList.innerHTML = "";

      try {
        const response = await fetch("/api/visit-requests/my", {
          headers: authHeaders()
        });

        const myRequests = await response.json();

        if (!response.ok) {
          requestList.innerHTML = "<p>Could not load requests.</p>";
          return;
        }

        if (myRequests.length === 0) {
          requestList.innerHTML = "<p>No requests submitted yet.</p>";
          return;
        }

        myRequests.forEach(req => {
          const createdAt = req.createdAt ? new Date(req.createdAt).toLocaleString() : "";
          const exitedAt = req.exitedAt ? new Date(req.exitedAt).toLocaleString() : "";
          const div = document.createElement("div");
          div.className = "card";
          div.innerHTML = `
            <p><strong>Patient:</strong> ${req.patientName}</p>
            <p><strong>Date:</strong> ${req.visitDate}</p>
            <p><strong>Reason:</strong> ${req.reason}</p>
            <p><strong>Status:</strong> ${req.status}</p>
            ${createdAt ? `<p><strong>Requested At:</strong> ${createdAt}</p>` : ""}
            ${exitedAt ? `<p><strong>Exited At:</strong> ${exitedAt}</p>` : ""}
            ${req.passCode ? `<p><strong>Pass Code:</strong> ${req.passCode}</p>` : ""}
            ${req.passCode && req.status !== "Expired" ? `<a class="qr-btn" href="/qr-code.html?passCode=${encodeURIComponent(req.passCode)}">Open QR Code</a>` : ""}
            ${req.status === "Expired" ? `<p><strong>QR Status:</strong> Expired</p>` : ""}
          `;
          requestList.appendChild(div);
        });
      } catch (error) {
        console.error(error);
        requestList.innerHTML = "<p>Could not load requests.</p>";
      }
    }

    document.addEventListener("click", function(e) {
      if (!e.target.closest(".menu-wrap")) {
        document.getElementById("historyMenu").classList.remove("open");
      }
    });

    loadRequests();
