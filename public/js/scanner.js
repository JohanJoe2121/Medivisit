const currentUser = JSON.parse(localStorage.getItem("currentUser"));
    const token = localStorage.getItem("token");
    if (!currentUser || currentUser.role !== "security") {
      window.location.href = "/login.html";
    }

    let qrScanner = null;
    let scanLocked = false;

    function setCameraStatus(message) {
      document.getElementById("cameraStatus").textContent = message;
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

        await qrScanner.start(
          { facingMode: "environment" },
          {
            fps: 10,
            qrbox: { width: 250, height: 250 }
          },
          onQrScanSuccess,
          function() {}
        );
      } catch (error) {
        console.error(error);
        setCameraStatus("Could not start QR scanner. Allow camera access or enter the pass code manually.");
      }
    }

    async function onQrScanSuccess(decodedText) {
      if (scanLocked) {
        return;
      }

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
          if (qrScanner.isScanning) {
            await qrScanner.stop();
          }
          await qrScanner.clear();
        } catch (error) {
          console.error(error);
        }
        qrScanner = null;
      }

      if (showStoppedMessage) {
        setCameraStatus("Camera scanner is not running.");
      }
    }

    function getPassCodeFromScan(value) {
      const scannedValue = (value || "").trim();

      try {
        const url = new URL(scannedValue);
        const passCodeFromUrl = url.searchParams.get("passCode");

        if (passCodeFromUrl) {
          return passCodeFromUrl.trim().toUpperCase();
        }
      } catch (error) {
        // The QR code can be a plain pass code instead of a URL.
      }

      const passCodeMatch = scannedValue.match(/PASS-[A-Z0-9]+/i);

      if (passCodeMatch) {
        return passCodeMatch[0].toUpperCase();
      }

      return scannedValue.toUpperCase();
    }

    function authHeaders() {
      return {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${token}`
      };
    }

    async function verifyPass(scannedPassCode) {
      const rawPassCode = scannedPassCode || document.getElementById("passCode").value;
      const passCode = getPassCodeFromScan(rawPassCode);
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
          scanResult.innerHTML = `
            <div class="result">
              <p class="error">${data.message || "Invalid pass code."}</p>
              <p><strong>Scanned:</strong> ${passCode}</p>
            </div>
          `;
          return;
        }

        renderValidPass(data.visit);
      } catch (error) {
        console.error(error);
        scanResult.innerHTML = `
          <div class="result">
            <p class="error">Could not check pass code.</p>
            <p><strong>Scanned:</strong> ${passCode}</p>
          </div>
        `;
      }
    }

    function renderValidPass(req) {
      const actionHtml = getVisitActionHtml(req);

      document.getElementById("scanResult").innerHTML = `
        <div class="result">
          <p class="${req.status === "Expired" ? "error" : "success"}">${req.status === "Expired" ? "Pass expired." : "Valid pass."}</p>
          <p><strong>Visitor:</strong> ${req.visitorName}</p>
          <p><strong>Patient:</strong> ${req.patientName}</p>
          <p><strong>Date:</strong> ${req.visitDate}</p>
          <p><strong>Status:</strong> ${req.status}</p>
          <p><strong>Pass Code:</strong> ${req.passCode}</p>
          ${req.securityApprovedAt ? `<p><strong>Security Approved At:</strong> ${new Date(req.securityApprovedAt).toLocaleString()}</p>` : ""}
          ${req.exitedAt ? `<p><strong>Exited At:</strong> ${new Date(req.exitedAt).toLocaleString()}</p>` : ""}
          ${actionHtml}
        </div>
      `;
    }

    function getVisitActionHtml(req) {
      if (req.status === "Expired") {
        return '<p class="error">This QR code is deactivated.</p>';
      }

      if (!req.verifiedBySecurity) {
        return `<button type="button" data-action-code="approvePass('${req.passCode}')">Approve</button>`;
      }

      const approvedAt = req.securityApprovedAt ? new Date(req.securityApprovedAt).getTime() : 0;
      const remainingSeconds = Math.ceil((30000 - (Date.now() - approvedAt)) / 1000);

      if (remainingSeconds > 0) {
        return `<p class="warning">Exit is blocked for ${remainingSeconds} more seconds.</p>`;
      }

      return `
        <p class="success">Approved by security. Visitor can now exit after this visit.</p>
        <button type="button" data-action-code="exitPass('${req.passCode}')">Exit</button>
      `;
    }

    async function approvePass(passCode) {
      const scanResult = document.getElementById("scanResult");

      try {
        const response = await fetch("/api/security/verify-pass", {
          method: "POST",
          headers: authHeaders(),
          body: JSON.stringify({ passCode })
        });

        const data = await response.json();

        if (!response.ok) {
          if (data.visit) {
            renderValidPass(data.visit);
          } else {
            scanResult.innerHTML = `<p class="error">${data.message || "Could not approve pass."}</p>`;
          }
          return;
        }

        renderValidPass(data.visit);
      } catch (error) {
        console.error(error);
        scanResult.innerHTML = '<p class="error">Could not approve pass.</p>';
      }
    }

    async function exitPass(passCode) {
      const scanResult = document.getElementById("scanResult");

      try {
        const response = await fetch("/api/security/exit-pass", {
          method: "POST",
          headers: authHeaders(),
          body: JSON.stringify({ passCode })
        });

        const data = await response.json();

        if (!response.ok) {
          if (data.visit) {
            renderValidPass(data.visit);
          } else {
            scanResult.innerHTML = `<p class="error">${data.message || "Could not record exit."}</p>`;
          }
          return;
        }

        renderValidPass(data.visit);
      } catch (error) {
        console.error(error);
        scanResult.innerHTML = '<p class="error">Could not record exit.</p>';
      }
    }

    window.addEventListener("beforeunload", function() {
      stopScanner(false);
    });
