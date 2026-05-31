const form = document.getElementById("registerForm");
  const message = document.getElementById("message");

  function readPhoto(file) {
    return new Promise((resolve, reject) => {
      if (!file) {
        resolve("");
        return;
      }

      const reader = new FileReader();
      reader.onload = () => resolve(reader.result);
      reader.onerror = reject;
      reader.readAsDataURL(file);
    });
  }

  form.addEventListener("submit", async function (e) {
    e.preventDefault();

    const fullName = document.getElementById("fullName").value.trim();
    const email = document.getElementById("email").value.trim().toLowerCase();
    const password = document.getElementById("password").value.trim();
    const birthDate = document.getElementById("birthDate").value;
    const address = document.getElementById("address").value.trim();
    const role = "visitor";
    const photo = await readPhoto(document.getElementById("photo").files[0]);

    try {
      const response = await fetch("/api/auth/register", {
        method: "POST",
        headers: {
          "Content-Type": "application/json"
        },
        body: JSON.stringify({
          fullName,
          email,
          password,
          role,
          birthDate,
          address,
          photo
        })
      });

      const data = await response.json();

      if (!response.ok) {
        message.style.color = "red";
        message.textContent = data.message || "Registration failed.";
        return;
      }

      message.style.color = "green";
      message.textContent = "Registration successful. You can now login.";

      console.log("Registered User ID:", data.user.id);
      console.log("Registered User Details:", data.user);

      form.reset();

    } catch (error) {
      message.style.color = "red";
      message.textContent = "Server error. Please try again.";
      console.error("Registration error:", error);
    }
  });
