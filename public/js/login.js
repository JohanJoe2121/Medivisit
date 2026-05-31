const loginForm = document.getElementById("loginForm");
  const message = document.getElementById("message");

  loginForm.addEventListener("submit", async function(e) {
    e.preventDefault();

    const email = document.getElementById("email").value.trim().toLowerCase();
    const password = document.getElementById("password").value.trim();

    try {
      const response = await fetch("/api/auth/login", {
        method: "POST",
        headers: {
          "Content-Type": "application/json"
        },
        body: JSON.stringify({
          email,
          password
        })
      });

      const data = await response.json();

      if (!response.ok) {
        message.style.color = "red";
        message.textContent = data.message || "Login failed.";
        return;
      }

      localStorage.setItem("token", data.token);
      localStorage.setItem("currentUser", JSON.stringify(data.user));

      console.log("Logged-in User ID:", data.user.id);
      console.log("Logged-in User Details:", data.user);

      const role = (data.user.role || "").trim().toLowerCase();

      if (role === "visitor") {
        window.location.href = "/visitor-dashboard.html";
      } else if (role === "patient") {
        window.location.href = "/patient-dashboard.html";
      } else if (role === "doctor" || role === "staff") {
        window.location.href = "/doctor-dashboard.html";
      } else if (role === "security") {
        window.location.href = "/security-dashboard.html";
      } else if (role === "admin") {
        window.location.href = "/admin-dashboard.html";
      } else {
        message.style.color = "red";
        message.textContent = `Unknown user role: ${data.user.role}`;
      }

    } catch (error) {
      message.style.color = "red";
      message.textContent = "Server error. Please try again.";
      console.error("Login error:", error);
    }
  });
