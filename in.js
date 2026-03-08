require("dotenv").config();
const { TelegramClient } = require("telegram");
const { StringSession } = require("telegram/sessions");
const input = require("input");
const { google } = require("googleapis");
const stream = require("stream");
const fs = require("fs");

let videos = JSON.parse(fs.readFileSync("./videos.json"));

const apiId = parseInt(process.env.TELEGRAM_API_ID || "21340292");
const apiHash = "619972338a987446041d1b68bffa04a2";
const stringSession = new StringSession(process.env.TELEGRAM_SESSION || "");

const DRIVE_ROOT_ID = "1oOVLiq9ZNgO-B1TKeAAEfvEQGMVRmHR0";

const folderCache = new Map();
const queue = [];

let activeWorkers = 0;
const MAX_WORKERS = 7;

let currentVideo = null;
let stopSending = false;

const client = new TelegramClient(stringSession, apiId, apiHash, {
  connectionRetries: 10,
});

const oAuth2Client = new google.auth.OAuth2(
  process.env.GOOGLE_CLIENT_ID ||
    "",
  process.env.GOOGLE_CLIENT_SECRET ||
    "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",
  process.env.GOOGLE_REDIRECT_URI
);

oAuth2Client.setCredentials({
  refresh_token:
    "",
});

const drive = google.drive({ version: "v3", auth: oAuth2Client });

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function cleanFileName(name) {
  if (!name) return "file";
  return name.replace(/[/\\?%*:|"<>]/g, "").slice(0, 100);
}

function saveVideos() {
  fs.writeFileSync("./videos.json", JSON.stringify(videos, null, 2));
}

function removeUploaded(link) {
  const index = videos.findIndex((v) => v.link === link);

  if (index !== -1) {
    videos.splice(index, 1);
    saveVideos();
    console.log("Removed from videos.json");
  }
}

async function createDriveFolder(pathArr, parentId) {
  let id = parentId;
  let currentPath = "";

  for (const folder of pathArr) {
    currentPath += "/" + folder;

    if (folderCache.has(currentPath)) {
      id = await folderCache.get(currentPath);
      continue;
    }

    const folderPromise = (async () => {
      const res = await drive.files.list({
        q: `'${id}' in parents and name='${folder}' and mimeType='application/vnd.google-apps.folder' and trashed=false`,
        fields: "files(id,name)",
      });

      if (res.data.files.length) return res.data.files[0].id;

      const created = await drive.files.create({
        requestBody: {
          name: folder,
          mimeType: "application/vnd.google-apps.folder",
          parents: [id],
        },
        fields: "id",
      });

      return created.data.id;
    })();

    folderCache.set(currentPath, folderPromise);
    id = await folderPromise;
  }

  return id;
}

async function uploadJob(job) {
  const folders = job.folderPath.split("/");
  const parentId = await createDriveFolder(folders, DRIVE_ROOT_ID);

  const pass = new stream.PassThrough();

  const uploadPromise = drive.files.create({
    requestBody: {
      name: cleanFileName(job.name) + ".mp4",
      parents: [parentId],
    },
    media: { body: pass },
    fields: "id",
  });

  const chunks = client.iterDownload({
    file: job.message.media,
    chunkSize: 1024 * 1024 * 2,
  });

  for await (const chunk of chunks) {
    pass.write(chunk);
  }

  pass.end();

  const uploaded = await uploadPromise;

  console.log("Uploaded:", uploaded.data.id);

  removeUploaded(job.link);
}

async function workerLoop() {
  if (activeWorkers >= MAX_WORKERS) return;
  if (!queue.length) return;

  activeWorkers++;

  while (queue.length) {
    const job = queue.shift();

    try {
      await uploadJob(job);
    } catch (err) {
      console.log("Upload error:", err.message);
    }
  }

  activeWorkers--;
}

function startWorkers() {
  for (let i = 0; i < MAX_WORKERS; i++) {
    workerLoop();
  }
}

async function sendStart(link) {
  const param = link.split("start=")[1];

  await client.sendMessage("AS_MultiverseRoBot", {
    message: `/start ${param}_360`,
  });

  console.log("Sent start:", param);
}

async function processVideos() {
  for (const video of videos) {
    if (stopSending) break;

    currentVideo = video;

    console.log("Requesting:", video.name);

    await sendStart(video.link);

    await sleep(22000);
  }

  console.log("Stopped sending new requests");
}

(async () => {
  await client.start({
    phoneNumber: async () => await input.text("Phone number: "),
    password: async () => await input.text("2FA password: "),
    phoneCode: async () => await input.text("OTP code: "),
  });

  console.log("Telegram Connected");

  client.addEventHandler(async (event) => {
    const message = event.message;

    if (!message) return;
    if (message.out) return;

    if (message.message && message.message.includes("Daily Limit")) {
      console.log("⚠️ Daily limit reached. Stopping new requests.");
      stopSending = true;
      return;
    }

    const file = message.video || message.document;

    if (!file) return;
    if (!currentVideo) return;

    console.log("Media received");

    queue.push({
      message,
      name: currentVideo.name,
      folderPath: currentVideo.folderPath,
      link: currentVideo.link,
    });

    console.log("Queued:", queue.length);

    startWorkers();
  });

  await processVideos();
})();