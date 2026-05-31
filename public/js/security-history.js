const currentUser = JSON.parse(localStorage.getItem("currentUser"));
    const token = localStorage.getItem("token");
    if (!currentUser || currentUser.role !== "security") {
      window.location.href = "/login.html";
    }

    function logout() {
      localStorage.removeItem("currentUser");
      localStorage.removeItem("token");
      window.location.href = "/login.html";
    }

    function refreshSecurityHistory() {
      document.getElementById("historyList").innerHTML = "";
      loadHistory();
    }

    async function loadHistory() {
      const historyList = document.getElementById("historyList");
      historyList.innerHTML = "";

      try {
        const response = await fetch("/api/security/approved-visits", {
          headers: {
            "Authorization": `Bearer ${token}`
          }
        });

        const visits = await response.json();

        if (!response.ok) {
          historyList.innerHTML = "<p>Could not load history.</p>";
          return;
        }

        if (visits.length === 0) {
          historyList.innerHTML = "<p>No entry or exit history found.</p>";
          return;
        }

        visits.forEach(req => {
          const div = document.createElement("div");
          div.className = "card";
          div.innerHTML = `
            <p><strong>Visitor:</strong> ${req.visitorName}</p>
            <p><strong>Patient:</strong> ${req.patientName}</p>
            <p><strong>Date:</strong> ${req.visitDate}</p>
            <p><strong>Status:</strong> ${req.status}</p>
            <p><strong>Pass Code:</strong> ${req.passCode}</p>
            ${req.securityApprovedAt ? `<p><strong>Entry Approved At:</strong> ${new Date(req.securityApprovedAt).toLocaleString()}</p>` : ""}
            ${req.exitedAt ? `<p><strong>Exited At:</strong> ${new Date(req.exitedAt).toLocaleString()}</p>` : ""}
          `;
          historyList.appendChild(div);
        });
      } catch (error) {
        console.error(error);
        historyList.innerHTML = "<p>Could not load history.</p>";
      }
    }

    loadHistory();
