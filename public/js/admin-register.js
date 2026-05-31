const currentUser = JSON.parse(localStorage.getItem("currentUser"));
    const token = localStorage.getItem("token");

    if (!currentUser || currentUser.role !== "admin") {
      window.location.href = "/login.html";
    }

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

    document.getElementById("adminForm").addEventListener("submit", async function(e) {
      e.preventDefault();

      const message = document.getElementById("message");
      const fullName = document.getElementById("fullName").value.trim();
      const email = document.getElementById("email").value.trim().toLowerCase();
      const password = document.getElementById("password").value.trim();
      const birthDate = document.getElementById("birthDate").value;
      const address = document.getElementById("address").value.trim();
      const photo = await readPhoto(document.getElementById("photo").files[0]);

      try {
        const response = await fetch("/api/admin/create-admin", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "Authorization": `Bearer ${token}`
          },
          body: JSON.stringify({ fullName, email, password, birthDate, address, photo })
        });

        const data = await response.json();

        if (!response.ok) {
          message.style.color = "red";
          message.textContent = data.message || "Could not create admin.";
          return;
        }

        message.style.color = "green";
        message.textContent = "Admin account created successfully.";
        document.getElementById("adminForm").reset();
      } catch (error) {
        console.error(error);
        message.style.color = "red";
        message.textContent = "Could not create admin.";
      }
    });
