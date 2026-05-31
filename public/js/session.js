(function () {
  document.addEventListener("click", (event) => {
    const trigger = event.target.closest("[data-action-code]");
    if (!trigger) return;

    event.preventDefault();
    Function(trigger.dataset.actionCode).call(trigger);
  });

  const token = localStorage.getItem("token");

  if (!token) {
    return;
  }

  function forceLogout() {
    localStorage.removeItem("currentUser");
    localStorage.removeItem("token");
    window.location.href = "/login.html";
  }

  async function checkSession() {
    try {
      const response = await fetch("/api/auth/me", {
        headers: {
          "Authorization": `Bearer ${token}`
        }
      });

      if (response.status === 401 || response.status === 403) {
        forceLogout();
      }
    } catch (error) {
      console.error("Session check failed:", error);
    }
  }

  window.checkSession = checkSession;
  checkSession();
  setInterval(checkSession, 5000);
})();
