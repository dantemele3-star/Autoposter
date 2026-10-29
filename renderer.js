const { ipcRenderer } = require('electron');

document.getElementById('postBtn').addEventListener('click', async () => {
    const statusDiv = document.getElementById('status');
    statusDiv.innerText = "⏳ Sending to Gameflip...";
    statusDiv.style.color = "black";

    const item = {
        title: document.getElementById('title').value,
        description: document.getElementById('description').value,
        price: document.getElementById('price').value,
        category: document.getElementById('category').value,
        quantity: document.getElementById('quantity').value,
        imagePath: document.getElementById('imagePath').value
    };

    const result = await ipcRenderer.invoke('post-listing', item);

    if (result.success) {
        statusDiv.innerText = `✅ Success! Listing ID: ${result.id}`;
        statusDiv.style.color = "green";
    } else {
        statusDiv.innerText = `❌ Error: ${result.error}`;
        statusDiv.style.color = "red";
    }
});