const form = document.getElementById("registerForm");
    const message = document.getElementById("message");
    const role = "doctor";

    function readPhoto(file) {
      return new Promise((resolve, reject) => {
        if (!file) return resolve("");
        const reader = new FileReader();
        reader.onload = () => resolve(reader.result);
        reader.onerror = reject;
        reader.readAsDataURL(file);
      });
    }

    form.addEventListener("submit", async function(e) {
      e.preventDefault();
      const photo = await readPhoto(document.getElementById("photo").files[0]);
      const response = await fetch("/api/auth/register", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          fullName: document.getElementById("fullName").value.trim(),
          email: document.getElementById("email").value.trim().toLowerCase(),
          password: document.getElementById("password").value.trim(),
          birthDate: document.getElementById("birthDate").value,
          address: document.getElementById("address").value.trim(),
          role,
          photo
        })
      });
      const data = await response.json();
      message.style.color = response.ok ? "green" : "red";
      message.textContent = response.ok ? "Registration successful. You can now login." : (data.message || "Registration failed.");
      if (response.ok) form.reset();
    });
