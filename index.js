const express = require("express");
const { spawn, execSync } = require("child_process");
const fs = require("fs");
const path = require("path");

const app = express();
app.use(express.json());

const databaseFile = path.join(__dirname, "servers.txt");
const image = "ghcr.io/ma4z-sys/vps_gen_v4:latest";

function addToDatabase(containerName, sshCommand) {
  fs.appendFileSync(databaseFile, `${containerName}|${sshCommand}\n`);
}

const configPath = path.join("./config.json");

if (!fs.existsSync(configPath)) {
  console.log("⚠️  Please Create a node on your Ploxora Panel then copy the node command and run it first");
  process.exit(1);
}
let config;
try {
  config = JSON.parse(fs.readFileSync(configPath, "utf8"));
} catch (err) {
  process.exit(1);
}

app.use((req, res, next) => {
  const queryKey = req.query["x-verification-key"]; // <-- from query string

  if (!queryKey || queryKey !== config.token) {
    return res.status(403).json({ error: "Forbidden: Invalid verification key" });
  }

  next();
});

function listServersFromFile() {
  try {
    return fs.readFileSync(databaseFile, "utf8").split("\n").filter(Boolean);
  } catch {
    return [];
  }
}

async function captureSSHCommand(proc) {
  return new Promise((resolve) => {
    let sshCommand = null;
    let retries = 0;
    const maxRetries = 30;

    proc.stdout.on("data", (data) => {
      const lines = data.toString().split("\n");
      lines.forEach((line) => {
        if (line.includes("ssh ") && !line.includes("ro-")) {
          sshCommand = line.trim();
          resolve(sshCommand);
        }
      });
    });

    const interval = setInterval(() => {
      retries++;
      if (sshCommand || retries >= maxRetries) {
        clearInterval(interval);
        resolve(sshCommand);
      }
    }, 1000);
  });
}

// API Endpoints
app.post("/deploy", async (req, res) => {
  const { ram , cores  } = req.body;
  let containerId;
  try {
    containerId = execSync(
      `docker run -itd --privileged --cap-add=ALL --memory ${ram} --cpus ${cores} ${image}`
    )
      .toString()
      .trim();
  } catch (err) {
    return res.status(500).json({ error: `Error creating Docker container: ${err}` });
  }

  let execCmd;
  try {
    execCmd = spawn("docker", ["exec", containerId, "tmate", "-F"]);
  } catch (err) {
    execSync(`docker kill ${containerId}`);
    execSync(`docker rm ${containerId}`);
    return res.status(500).json({ error: `Error executing tmate: ${err}` });
  }

  const sshSession = await captureSSHCommand(execCmd);
  if (sshSession) {
    addToDatabase(containerId, sshSession);
    return res.json({
      message: "Instance created successfully",
      containerId,
      ssh: sshSession,
    });
  } else {
    execSync(`docker kill ${containerId}`);
    execSync(`docker rm ${containerId}`);
    return res.status(500).json({ error: "Instance creation failed or timed out" });
  }
});
app.get("/checkdockerrunning", (req, res) => {
  try {
    execSync("docker info", { stdio: "pipe" });
    return res.json({ docker: "running" });
  } catch (err) {
    return res.status(500).json({ docker: "not running", error: err.message });
  }
});
app.get("/status/:containerId", (req, res) => {
  const { containerId } = req.params;

  try {
    const status = execSync(`docker inspect --format='{{.State.Status}}' ${containerId}`)
      .toString()
      .trim();
    return res.json({ containerId, status });
  } catch (err) {
    return res.status(404).json({ error: `Container not found or Docker error: ${err.message}` });
  }
});

app.post("/action/:action/:containerId", (req, res) => {
  const { action, containerId } = req.params;
  const validActions = ["start", "stop", "restart"];

  if (!validActions.includes(action)) {
    return res.status(400).json({ error: "Invalid action. Allowed: start, stop, restart" });
  }

  try {
    execSync(`docker ${action} ${containerId}`);
    return res.json({ containerId, action, message: `Container ${action}ed successfully` });
  } catch (err) {
    return res.status(500).json({ error: `Failed to ${action} container: ${err.message}` });
  }
});
app.post("/ressh", async (req, res) => {
  const { containerId } = req.body;

  try {
    let status = execSync(`docker inspect --format='{{.State.Running}}' ${containerId}`)
      .toString()
      .trim();

    if (status === "'false'") {
      execSync(`docker kill ${containerId}`);
      execSync(`docker rm ${containerId}`);
    }
    execSync(`docker start ${containerId}`);

    const execCmd = spawn("docker", ["exec", containerId, "tmate", "-F"]);
    const sshSession = await captureSSHCommand(execCmd);

    if (sshSession) {
      return res.json({
        message: "SSH session re-established",
        containerId,
        ssh: sshSession,
      });
    } else {
      return res.status(500).json({ error: "Failed to capture SSH session command" });
    }
  } catch (err) {
    return res.status(500).json({ error: `Error: ${err}` });
  }
});

app.get("/list", (req, res) => {
  const serverDetails = listServersFromFile();
  if (!serverDetails.length) {
    return res.json({ message: "No server data available" });
  }
  res.json({ servers: serverDetails });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`PloxoraDaemon is running on ${PORT}`);
});
