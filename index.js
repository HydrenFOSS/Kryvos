const express = require("express");
const { spawn, execSync } = require("child_process");
const fs = require("fs");
const path = require("path");
const Logger = require("./utilities/log");
const logger = new Logger({ prefix: "Ploxora", level: "debug" });
const app = express();
app.use(express.json());

const databaseFile = path.join(__dirname, "servers.txt");
const image = "ghcr.io/ma4z-sys/vps_gen_v4:latest";

function addToDatabase(containerName, sshCommand) {
  fs.appendFileSync(databaseFile, `${containerName}|${sshCommand}\n`);
}

const configPath = path.join("./config.json");

if (!fs.existsSync(configPath)) {
  logger.warn("⚠️  Please Create a node on your Ploxora Panel then copy the node command and run it first");
  process.exit(1);
}
let config;
try {
  config = JSON.parse(fs.readFileSync(configPath, "utf8"));
} catch (err) {
  logger.error(err)
  process.exit(1);
}

app.use((req, res, next) => {
  const queryKey = req.query["x-verification-key"]; // <-- from query string

  if (!queryKey || queryKey !== config.token) {
    return res.status(403).json({ error: "Forbidden: Invalid verification key" });
  }

  next();
});
const asciiart = `
  _____  _                          _____                                   
 |  __ \\| |                        |  __ \\                                  
 | |__) | | _____  _____  _ __ __ _| |  | | __ _  ___ _ __ ___   ___  _ __  
 |  ___/| |/ _ \\ \\/ / _ \\| '__/ _\` | |  | |/ _\` |/ _ \\ '_ \` _ \\ / _ \\| '_ \\ 
 | |    | | (_) >  < (_) | | | (_| | |__| | (_| |  __/ | | | | | (_) | | | |
 |_|    |_|\\___/_/\\_\\___/|_|  \\__,_|_____/ \\__,_|\\___|_| |_| |_|\\___/|_| |_|
`;

function listServersFromFile() {
  try {
    return fs.readFileSync(databaseFile, "utf8").split("\n").filter(Boolean);
  } catch {
    return [];
  }
}
/**
 * Pulls a Docker image and logs each output line via Catloggr
 * @param {string} image - Docker image to pull
 */
function pullImage(image) {
  return new Promise((resolve, reject) => {
    logger.info(`Starting pull for Docker image: ${image}`);

    const dockerPull = spawn("docker", ["pull", image]);

    dockerPull.stdout.on("data", (data) => {
      data.toString()
        .split("\n")
        .filter(line => line.trim())
        .forEach(line => {
          logger.info(line);
        });
    });

    dockerPull.stderr.on("data", (data) => {
      data.toString()
        .split("\n")
        .filter(line => line.trim())
        .forEach(line => {
          const log = new Catloggr({ prefix: "Ploxora" }); // init each line
          log.error(line);
        });
    });

    dockerPull.on("close", (code) => {
      if (code === 0) {
        logger.info(`Successfully pulled image: ${image}`);
        resolve();
      } else {
        reject(new Error(`Docker pull exited with code ${code}`));
      }
    });

    dockerPull.on("error", (err) => {
      logger.error(`Failed to start docker pull: ${err.message}`);
      reject(err);
    });
  });
}
pullImage(image);
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
  const { ram, cores, name } = req.body;
  let containerId;
  try {
    logger.info(`Creating New VPS with ram: ${ram}, cores: ${cores} and name: ${name}`)
    containerId = execSync(
  `docker run -itd --privileged --cap-add=ALL --memory ${ram} --cpus ${cores} --hostname ${name} ${image}`
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
app.post("/vps/delete", (req, res) => {
  const { containerId } = req.body;

  if (!containerId) {
    return res.status(400).json({ error: "containerId is required" });
  }

  try {
    // Kill and remove the container
    execSync(`docker kill ${containerId}`, { stdio: "ignore" });
    execSync(`docker rm ${containerId}`, { stdio: "ignore" });

    // Remove from servers.txt
    let servers = listServersFromFile();
    servers = servers.filter(line => !line.startsWith(containerId));

    fs.writeFileSync(databaseFile, servers.join("\n") + (servers.length ? "\n" : ""));

    return res.json({ message: "Container deleted successfully", containerId });
  } catch (err) {
    return res.status(500).json({ error: `Failed to delete container: ${err.message}` });
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
    if (!containerId) return res.status(400).json({ error: "Missing containerId" });

    let status = execSync(`docker inspect --format='{{.State.Running}}' ${containerId}`).toString().trim();

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
      // always return JSON
      return res.status(500).json({
        error: "Failed to capture SSH session command",
        containerId,
        ssh: null
      });
    }
  } catch (err) {
    return res.status(500).json({
      error: `Error: ${err.message || err}`,
      containerId,
      ssh: null
    });
  }
});


app.get("/list", (req, res) => {
  const serverDetails = listServersFromFile();
  if (!serverDetails.length) {
    return res.json({ message: "No server data available" });
  }
  res.json({ servers: serverDetails });
});

app.get("/version", (req, res) => {
  res.json({ version: "1.0.0" });
});

app.get("/stats/:containerId", (req, res) => {
  const { containerId } = req.params;

  try {
    // 1. Memory + CPU (live stats, single snapshot)
    const statsRaw = execSync(
      `docker stats ${containerId} --no-stream --format "{{.MemUsage}}|{{.CPUPerc}}"`
    )
      .toString()
      .trim();

    // Example: "24.3MiB / 1GiB|0.32%"
    const [memUsageRaw, cpuRaw] = statsRaw.split("|");
    const memUsed = memUsageRaw.split("/")[0].trim(); // take only "24.3MiB"
    let memoryMB = 0;

    if (memUsed.toLowerCase().includes("mib")) {
      memoryMB = parseFloat(memUsed) || 0;
    } else if (memUsed.toLowerCase().includes("gib")) {
      memoryMB = (parseFloat(memUsed) || 0) * 1024;
    } else if (memUsed.toLowerCase().includes("kib")) {
      memoryMB = (parseFloat(memUsed) || 0) / 1024;
    } else {
      memoryMB = parseFloat(memUsed) || 0; // fallback (assume MB)
    }

    const cpuPercent = parseFloat(cpuRaw.replace("%", "").trim()) || 0;

    // 2. Disk usage (Writable layer only, in MB)
    const diskRaw = execSync(
      `docker inspect --size ${containerId} --format '{{.SizeRootFs}}'`
    )
      .toString()
      .trim();

    const diskMB = (parseInt(diskRaw, 10) / (1024 * 1024)).toFixed(2);

    // 3. Status of the Container
    const status = execSync(`docker inspect --format='{{.State.Status}}' ${containerId}`)
      .toString()
      .trim();
    res.json({
      containerId,
      memoryMB,
      status,
      cpuPercent,
      diskUsageMB: parseFloat(diskMB),
    });
  } catch (err) {
    return res
      .status(500)
      .json({ error: `Failed to get stats: ${err.message}` });
  }
});
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`\n${asciiart}\n`)
  logger.info(`PloxoraDaemon is running on ${PORT}`);
});
