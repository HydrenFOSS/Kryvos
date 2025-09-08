
# **Kryvos**

Easily manage your Ploxora Panel nodes with **Kryvos**. Follow the steps below to get started.

---

## **Installation**

Install the dependencies:

```bash
npm install
```

---

## **Node Initialization**

1. Go to your Ploxora Panel and create a **node**.
2. Copy the initialization command provided by the panel, it should look like:

```bash
npm run initialize -- --key RANDOM_KEY --ploxora https://example.com
```

Run this command to register your node with Kryvos.

---

## **Starting the Daemon**

Start the daemon using Node:

```bash
node index.js
```

Or use **PM2** for process management and automatic restarts:

```bash
pm2 start index.js --name kryvos
```
