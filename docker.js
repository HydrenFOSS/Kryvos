const { execSync, spawn } = require("child_process");
const Logger = require("./utilities/log");
const logger = new Logger({ prefix: "docker", level: "debug", pcolo: "blue" });

function dockerExec(cmd) {
  try {
    const output = execSync(`docker ${cmd}`, { encoding: "utf-8" }).trim();
    if (output) {
      output
        .split(/\r?\n/)
        .filter((line) => line.trim() !== "")
        .forEach((line) => logger.info(line));
    }
    return output;
  } catch (err) {
    const errMsg = err.stderr?.toString() || err.message;
    errMsg
      .split(/\r?\n/)
      .filter((line) => line.trim() !== "")
      .forEach((line) => logger.error(line));
    throw err;
  }
}

function dockerSpawn(args) {
  const child = spawn("docker", args);

  const logStream = (data, method) => {
    data
      .toString()
      .split(/\r?\n/)
      .filter((line) => line.trim() !== "")
      .forEach((line) => logger[method](line));
  };

  child.stdout.on("data", (data) => logStream(data, "info"));
  child.stderr.on("data", (data) => logStream(data, "warn"));
  child.on("close", (code) => logger.init(`process exited with code ${code}`));

  return child;
}


module.exports = {
  create: (opts) => dockerExec(`run ${opts}`),
  delete: (id) => dockerExec(`rm -f ${id}`),
  kill: (id) => dockerExec(`kill ${id}`),
  rm: (id) => dockerExec(`rm ${id}`),
  start: (id) => dockerExec(`start ${id}`),
  restart: (id) => dockerExec(`restart ${id}`),
  stop: (id) => dockerExec(`stop ${id}`),
  info: () => dockerExec("info"),
  inspect: (id, format) =>
    dockerExec(`inspect ${format ? `--format='${format}'` : ""} ${id}`),
  stats: (id) =>
    dockerExec(
      `stats ${id} --no-stream --format "{{.MemUsage}}|{{.CPUPerc}}|{{.NetIO}}"`
    ),
  system: (subcmd = "df --format '{{.Size}}'") =>
    dockerExec(`system ${subcmd}`),
  exec: dockerExec,
  spawn: dockerSpawn,
};
