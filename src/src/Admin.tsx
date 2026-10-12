import { upload } from "@vercel/blob/client";
import React, { useState, useEffect, useRef } from "react";
import "./style.css";
import brandDefault from "./photos/contact-sheet.png";
async function api(path: string, method = "GET", body?: any) {
  const r = await fetch("/api/admin/" + path, {
    method,
    headers:
      body instanceof FormData || body instanceof Blob
        ? undefined
        : { "Content-Type": "application/json" },
    body:
      body === undefined
        ? undefined
        : body instanceof FormData || body instanceof Blob
          ? body
          : JSON.stringify(body),
  });
  const text = await r.text();
  let data: any;
  try {
    data = JSON.parse(text);
  } catch {
    throw Error(
      "Server returned an unreadable response (" +
        r.status +
        "). Please retry later.",
    );
  }
  if (!r.ok) throw Error(data.error || "Request failed (" + r.status + ").");
  if (method !== "GET") {
    const m = path.match(
      /^galleries\/([^/]+)\/(settings|title|photos|publish)$/,
    );
    if (m)
      window.dispatchEvent(
        new CustomEvent("gallery-change", {
          detail: { id: m[1], published: m[2] === "publish" },
        }),
      );
  }
  return data;
}
async function testDriveStorage(report: (s: string) => void) {
  report("Testing personal Drive connection and 6 MB upload...");
  const bytes = crypto.getRandomValues(new Uint8Array(65536));
  const data = new Uint8Array(6 * 1024 * 1024);
  for (let i = 0; i < data.length; i += bytes.length) data.set(bytes, i);
  const canvas = document.createElement("canvas");
  canvas.width = 1;
  canvas.height = 1;
  const jpeg = await new Promise<Blob>((resolve) =>
    canvas.toBlob((b) => resolve(b!), "image/jpeg"),
  );
  data.set(new Uint8Array(await jpeg.arrayBuffer()), 0);
  const sha256 = Array.from(
    new Uint8Array(await crypto.subtle.digest("SHA-256", data)),
  )
    .map((x) => x.toString(16).padStart(2, "0"))
    .join("");
  const start = await api("drive/test", "POST", { size: data.length, sha256 });
  let result: any = { ok: false, direct_upload: false, error: "" };
  try {
    const r = await fetch(start.session, {
      method: "PUT",
      headers: { "Content-Type": "image/jpeg" },
      body: new Blob([data], { type: "image/jpeg" }),
    });
    if (!r.ok) throw Error("Direct Google upload failed (" + r.status + ").");
    result.direct_upload = true;
    report("Checking private Drive file and streaming download...");
    const down = await fetch(
      "/api/admin/drive/test-download?receipt=" +
        encodeURIComponent(start.receipt),
    );
    if (!down.ok) throw Error((await down.json()).error || "Download failed.");
    const actual = await down.arrayBuffer();
    result.size = actual.byteLength;
    result.sha256 = Array.from(
      new Uint8Array(await crypto.subtle.digest("SHA-256", actual)),
    )
      .map((x) => x.toString(16).padStart(2, "0"))
      .join("");
    result.ok = result.size === data.length && result.sha256 === sha256;
    if (!result.ok) throw Error("Download checksum does not match.");
  } catch (e: any) {
    result.error = e.message;
  }
  const saved = await api(
    "drive/test-result?receipt=" + encodeURIComponent(start.receipt),
    "POST",
    result,
  );
  report(
    (saved.status === "passed"
      ? "Drive storage test passed: private personal Drive, direct 6 MB upload, streamed download, exact checksum."
      : "Drive storage test failed: " + result.error) +
      " Test receipt: " +
      start.receipt,
  );
  if (saved.status !== "passed")
    throw Error(
      "Drive test failed: " + result.error + " Test receipt: " + start.receipt,
    );
}
function transferOriginal(
  url: string,
  file: Blob,
  type: string,
  range: string,
  signal: AbortSignal,
  progress: (n: number) => void,
) {
  return new Promise<void>((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    const cleanup = () => signal.removeEventListener("abort", abort);
    const abort = () => xhr.abort();
    xhr.open("PUT", url);
    xhr.setRequestHeader("Content-Type", type);
    xhr.setRequestHeader("Content-Range", range);
    xhr.upload.onprogress = (e) => progress(e.loaded);
    xhr.onload = () => {
      cleanup();
      if (xhr.status >= 200 && xhr.status < 300) {
        progress(file.size);
        resolve();
      } else
        reject(
          Error(
            "Drive original upload stopped (" + xhr.status + "). Retry upload.",
          ),
        );
    };
    xhr.onerror = () => {
      cleanup();
      reject(Error("Drive connection interrupted. Retry upload."));
    };
    xhr.onabort = () => {
      cleanup();
      reject(new DOMException("Upload stopped", "AbortError"));
    };
    signal.addEventListener("abort", abort, { once: true });
    if (signal.aborted) {
      cleanup();
      reject(new DOMException("Upload stopped", "AbortError"));
      return;
    }
    xhr.send(file);
  });
}
async function uploadOriginal(
  job: any,
  pid: string,
  file: File,
  row: any,
  signal: AbortSignal,
  progress: (n: number) => void,
  stage: (s: string) => void,
  sessionQueue: (fn: () => Promise<any>) => Promise<any>,
) {
  if (!row.sha256) {
    stage("Checking original");
    row.sha256 = Array.from(
      new Uint8Array(
        await crypto.subtle.digest("SHA-256", await file.arrayBuffer()),
      ),
    )
      .map((x) => x.toString(16).padStart(2, "0"))
      .join("");
  }
  signal.throwIfAborted();
  if (!row.driveSession) {
    stage("Preparing private Drive");
    const s = await sessionQueue(() =>
      api("galleries/" + job.id + "/original-session", "POST", {
        photoId: pid,
        filename: file.name,
        mimeType: file.type,
        size: file.size,
        sha256: row.sha256,
      }),
    );
    row.driveSession = s.session;
  }
  let offset = 0;
  if (row.driveStarted) {
    stage("Checking resume position");
    const status = await fetch(row.driveSession, {
      method: "PUT",
      headers: { "Content-Range": "bytes */" + file.size },
      signal,
      body: new Blob([]),
    });
    if (status.ok) {
      row.originalDone = true;
      return;
    }
    if (status.status === 404 || status.status === 410) {
      row.driveSession = null;
      row.driveStarted = false;
      throw Error("Drive upload session expired. Retry to start again.");
    }
    if (status.status !== 308) throw Error("Could not resume Drive upload.");
    const range = status.headers.get("Range");
    if (range) offset = Number(range.split("-")[1]) + 1;
  }
  signal.throwIfAborted();
  row.driveStarted = true;
  stage("Uploading hi-res");
  await transferOriginal(
    row.driveSession,
    file.slice(offset),
    file.type,
    `bytes ${offset}-${file.size - 1}/${file.size}`,
    signal,
    progress,
  );
  row.originalDone = true;
}
export function Admin() {
  const [setup, setSetup] = useState<any>(null);
  useEffect(() => {
    fetch("/api/app/setup-status")
      .then((r) => r.json())
      .then(setSetup)
      .catch(() => {});
  }, []);
  const [settingsDrafts, setSettingsDrafts] = useState<Record<string, any>>({});
  const [settingsTab, setSettingsTab] = useState("look");
  function editSetting(key: string, value: any) {
    setSettingsDrafts((old) => ({
      ...old,
      [active.id]: {
        ...old[active.id],
        [key]: value,
        ...(key === "high_res" && !value ? { downloads: false } : {}),
      },
    }));
  }
  function galleryDirty(id: string) {
    return (
      Object.keys(settingsDrafts[id] || {}).length > 0 ||
      (active?.id === id && Object.keys(titleEdits).length > 0)
    );
  }
  async function saveGallery(job: any) {
    const changes = settingsDrafts[job.id] || {};
    if (Object.keys(changes).length) {
      await api("galleries/" + job.id + "/settings", "PATCH", changes);
      setSettingsDrafts((old) => {
        const next = { ...old };
        delete next[job.id];
        return next;
      });
      if (changes.website !== undefined) setNewWebsite(changes.website);
    }
    for (const [photoId, title] of Object.entries(titleEdits)) {
      await api("galleries/" + job.id + "/title", "PATCH", { photoId, title });
      setTitleEdits((old) => {
        const next = { ...old };
        delete next[photoId];
        return next;
      });
    }
    await load();
  }
  const [pickFilter, setPickFilter] = useState("all");
  const [ownerPicks, setOwnerPicks] = useState<any[]>([]);
  const [ownerPicksMessage, setOwnerPicksMessage] = useState("");
  const [newHighRes, setNewHighRes] = useState(false);
  const [newTheme, setNewTheme] = useState("dark");
  const [newPhotographer, setNewPhotographer] = useState("");
  const [newWebsite, setNewWebsite] = useState("");
  const [newShowWebsite, setNewShowWebsite] = useState(true);
  const websiteDefaultLoaded = useRef(false);
  const websiteDefaultDirty = useRef(false);
  const [websiteEdits, setWebsiteEdits] = useState<Record<string, string>>({});
  const [photographerEdits, setPhotographerEdits] = useState<
    Record<string, string>
  >({});
  const [brandLogo, setBrandLogo] = useState<string | null>(null),
    [brandStatus, setBrandStatus] = useState("");
  const [currentPassword, setCurrentPassword] = useState(""),
    [newPassword, setNewPassword] = useState(""),
    [confirmPassword, setConfirmPassword] = useState(""),
    [resetReady, setResetReady] = useState(false);
  useEffect(() => {
    if (new URLSearchParams(location.search).has("recover"))
      api("recovery/status")
        .then((r) => {
          setResetReady(r.ready);
          if (!r.ready)
            setStatus(
              "Recovery expired. Tap Recover with Google to try again.",
            );
        })
        .catch(() => setStatus("Recovery unavailable. Try again."));
  }, []);
  const [needsUpdate, setNeedsUpdate] = useState<Record<string, boolean>>(
    () => {
      try {
        return JSON.parse(
          localStorage.getItem("broach-gallery-needs-update") || "{}",
        );
      } catch {
        return {};
      }
    },
  );
  const [titleEdits, setTitleEdits] = useState<Record<string, string>>({});
  const [shortLinks, setShortLinks] = useState<Record<string, string>>({});
  const [migration, setMigration] = useState<any>(null),
    [migrationMessage, setMigrationMessage] = useState("");
  const [logged, setLogged] = useState(false),
    [password, setPassword] = useState(""),
    [remember, setRemember] = useState(false),
    [galleries, setGalleries] = useState<any[]>([]),
    [title, setTitle] = useState(""),
    [client, setClient] = useState(""),
    [active, setActive] = useState<any>(null),
    [expanded, setExpanded] = useState<string | null>(null),
    [deleteConfirm, setDeleteConfirm] = useState<string | null>(null),
    [link, setLink] = useState(""),
    [picks, setPicks] = useState<any[]>([]),
    [status, setStatus] = useState(""),
    [driveStatus, setDriveStatus] = useState(""),
    [useNames, setUseNames] = useState(true),
    [newFiles, setNewFiles] = useState<File[]>([]),
    [naming, setNaming] = useState(false),
    [busy, setBusy] = useState(false),
    [batch, setBatch] = useState<any[]>([]);
  const canvas = useRef<HTMLCanvasElement>(null);
  const addPhotos = useRef<HTMLDetailsElement>(null);
  const uploadController = useRef<AbortController | null>(null);
  const [uploading, setUploading] = useState(false);
  const [batchPublish, setBatchPublish] = useState("idle");
  const [uploadMeter, setUploadMeter] = useState("");
  async function load() {
    const rows = await api("galleries");
    const list = await Promise.all(
      rows.map(async (g: any) => {
        try {
          const photos = await api("galleries/" + g.id + "/picks");
          const notePhotos = photos.filter((p: any) => p.comments?.length);
          const noteCount = notePhotos.reduce(
            (n: number, p: any) => n + p.comments.length,
            0,
          );
          const proofKey = Array.from(
            new Uint8Array(
              await crypto.subtle.digest(
                "SHA-256",
                new TextEncoder().encode(g.token),
              ),
            ),
          )
            .map((x) => x.toString(16).padStart(2, "0"))
            .join("");
          return { ...g, notePhotos, noteCount, proofKey };
        } catch {
          return { ...g, noteError: true, notePhotos: [] };
        }
      }),
    );
    setGalleries(list);
    setActive((old: any) =>
      old ? list.find((g: any) => g.id === old.id) || old : old,
    );
    setLogged(true);
    if (!websiteDefaultLoaded.current) {
      try {
        const d = await api("gallery-defaults");
        if (!websiteDefaultDirty.current) setNewWebsite(d.website || "");
        websiteDefaultLoaded.current = true;
      } catch {}
    }
    try {
      const b = await api("branding");
      setBrandLogo(b.logo);
    } catch {}
    try {
      setMigration(await api("migration-status"));
    } catch {}
  }
  useEffect(() => {
    load().catch((e) =>
      setStatus(e.message || "Admin could not load. Please retry."),
    );
  }, []);
  useEffect(() => {
    const change = (e: any) =>
      setNeedsUpdate((old) => {
        const next = { ...old };
        if (e.detail.published) delete next[e.detail.id];
        else next[e.detail.id] = true;
        localStorage.setItem(
          "broach-gallery-needs-update",
          JSON.stringify(next),
        );
        return next;
      });
    window.addEventListener("gallery-change", change);
    return () => window.removeEventListener("gallery-change", change);
  }, []);
  useEffect(() => {
    const before = (e: BeforeUnloadEvent) => {
      if (
        Object.keys(settingsDrafts).length ||
        Object.keys(titleEdits).length ||
        Object.keys(needsUpdate).length ||
        batch.some((x) => x.state !== "Uploaded")
      ) {
        e.preventDefault();
        e.returnValue = "";
      }
    };
    window.addEventListener("beforeunload", before);
    return () => window.removeEventListener("beforeunload", before);
  }, [titleEdits, batch, needsUpdate, settingsDrafts]);
  async function action(fn: () => Promise<any>) {
    setBusy(true);
    setStatus("Working...");
    try {
      await fn();
      setStatus((old) =>
        old.startsWith("Drive storage test") ||
        old.startsWith("Password changed.") ||
        old === "Photos uploaded. Gallery is live."
          ? old
          : "Done.",
      );
    } catch (e: any) {
      setStatus(e.message);
    } finally {
      setBusy(false);
    }
  }
  async function migrationLoad() {
    const m = await api("migration-status");
    setMigration(m);
    return m;
  }
  async function migrate(remove: boolean) {
    setMigrationMessage(
      remove
        ? "Checking verified copies before removing old host copies..."
        : "Copying originals to your private Google Drive and verifying downloads...",
    );
    try {
      const m = await migrationLoad();
      if (remove && !m.ready_to_remove)
        throw Error("Copy and verify every original first.");
      const rows = remove ? m.items : m.items.filter((p: any) => !p.verified);
      for (let i = 0; i < rows.length; i++) {
        const p = rows[i];
        setMigrationMessage(
          (remove ? "Removing old host copies: " : "Copying and verifying: ") +
            (i + 1) +
            " of " +
            rows.length,
        );
        await api(
          "galleries/" +
            p.jobId +
            (remove ? "/migration-remove" : "/migration-copy"),
          "POST",
          { photoId: p.photoId },
        );
        await migrationLoad();
      }
      setMigrationMessage(
        remove
          ? "Old host originals removed. Originals are now only in your private Google Drive."
          : "Every existing original has a verified private Drive copy. Old host copies have not been removed.",
      );
      await load();
    } catch (e: any) {
      setMigrationMessage("Stopped: " + e.message);
      await migrationLoad();
      throw e;
    }
  }
  async function card(
    job: string,
    photographer = "",
    website = "",
    branding: any = {},
  ) {
    await document.fonts.load('30px "Broach Archivo Black"');
    await document.fonts.load('30px "Broach Assistant"');
    const c = canvas.current!,
      ctx = c.getContext("2d")!;
    ctx.fillStyle = "#f3f3f3";
    ctx.fillRect(0, 0, 1200, 630);
    ctx.fillStyle = branding.header_color || "#121212";
    ctx.font =
      "54px " +
      (branding.header_font === "assistant"
        ? '"Broach Assistant"'
        : branding.header_font === "serif"
          ? "Georgia"
          : '"Broach Archivo Black"');
    const words = job.split(/\s+/);
    let line = "",
      y = 210;
    for (const word of words) {
      if (ctx.measureText(line + " " + word).width > 1020) {
        ctx.fillText(line, 70, y);
        line = word;
        y += 70;
      } else line += (line ? " " : "") + word;
    }
    ctx.fillText(line, 70, y);
    ctx.font = '30px "Broach Assistant"';
    if (photographer.trim())
      ctx.fillText("Photography by " + photographer.trim(), 70, 500);
    ctx.fillStyle = branding.brand_accent || "#355800";
    ctx.font = '24px "Broach Assistant"';
    if (website.trim())
      ctx.fillText(website.trim().replace(/^https?:\/\//i, ""), 70, 548);
    return await new Promise<Blob>((resolve) =>
      c.toBlob((b) => resolve(b!), "image/png"),
    );
  }
  async function publishGallery(job: any) {
    for (const [photoId, title] of Object.entries(titleEdits)) {
      await api("galleries/" + job.id + "/title", "PATCH", { photoId, title });
    }
    setTitleEdits({});
    const png = await card(
      job.title,
      job.photographer ?? "",
      job.show_website === false ? "" : (job.website ?? ""),
      job,
    );
    const r = await fetch("/api/admin/galleries/" + job.id + "/preview", {
      method: "PUT",
      headers: { "Content-Type": "image/png" },
      body: png,
    });
    if (!r.ok) throw Error("Share preview could not update.");
    await api("galleries/" + job.id + "/publish", "POST");
    await load();
  }
  async function makeProof(file: File) {
    if (!["image/jpeg", "image/png", "image/webp"].includes(file.type))
      throw Error(
        "Use JPEG, PNG or WebP for automatic proofs. Export TIFF/HEIC/RAW to JPEG first.",
      );
    const bitmap = await createImageBitmap(file);
    const scale = Math.min(1, 1500 / Math.max(bitmap.width, bitmap.height));
    const c = document.createElement("canvas");
    c.width = Math.round(bitmap.width * scale);
    c.height = Math.round(bitmap.height * scale);
    c.getContext("2d")!.drawImage(bitmap, 0, 0, c.width, c.height);
    bitmap.close();
    return await new Promise<Blob>((resolve, reject) =>
      c.toBlob(
        (b) => (b ? resolve(b) : reject(Error("Could not make proof."))),
        "image/jpeg",
        0.86,
      ),
    );
  }
  function chooseBatch(files: FileList | File[]) {
    if (busy || !active) return;
    if (galleryDirty(active.id)) {
      setStatus("Tap Save before adding photos.");
      return;
    }
    const selected = Array.from(files).sort((a, b) =>
      a.name.localeCompare(b.name, undefined, { numeric: true }),
    );
    if (!selected.length) return;
    const rows = selected.map((file) => ({
      file,
      id: crypto.randomUUID(),
      title: useNames ? file.name : "",
      state: "Ready",
      proofDone: false,
      originalDone: false,
    }));
    setBatch(rows);
    action(() => uploadBatch(active, rows));
  }
  function stopUpload() {
    uploadController.current?.abort();
    setStatus("Stopping upload. Completed photos stay saved.");
  }
  async function uploadBatch(job: any = active, rows: any[] = batch) {
    if (!job) return;
    const remaining = rows.filter((x) => x.state !== "Uploaded");
    if (job.photos.length + remaining.length > 500)
      throw Error("This gallery supports up to 500 photographs.");
    const bytes = remaining.reduce((n, x) => n + x.file.size, 0);
    if (bytes > 250 * 1024 * 1024)
      throw Error(
        "Keep each batch under 250 MB. Originals go directly to your private owner Google Drive.",
      );
    const names = new Set();
    for (const row of remaining) {
      if (names.has(row.file.name.toLowerCase()))
        throw Error(
          "Duplicate filenames in this batch. Rename them before upload.",
        );
      names.add(row.file.name.toLowerCase());
      if (row.file.size > 80 * 1024 * 1024)
        throw Error(row.file.name + " is over 80 MB.");
      if (!["image/jpeg", "image/png", "image/webp"].includes(row.file.type))
        throw Error(
          "Automatic batch proofs require JPEG, PNG or WebP. Export TIFF originals to JPEG, PNG or WebP before upload.",
        );
    }
    const controller = new AbortController();
    uploadController.current = controller;
    setUploading(true);
    setBatchPublish("idle");
    setUploadMeter("Preparing upload...");
    if (addPhotos.current) addPhotos.current.open = true;
    const started = performance.now();
    let sessionChain = Promise.resolve(),
      meterLast = 0;
    const transferred = new Map<string, number>();
    const sessionQueue = (fn: () => Promise<any>) => {
      const next = sessionChain.then(() => {
        controller.signal.throwIfAborted();
        return fn();
      });
      sessionChain = next.catch(() => {});
      return next;
    };
    const refresh = (force = false) => {
      const now = performance.now();
      if (!force && now - meterLast < 250) return;
      meterLast = now;
      const bytesSent = Array.from(transferred.values()).reduce(
          (a, b) => a + b,
          0,
        ),
        elapsed = Math.max((now - started) / 1000, 0.01),
        done = rows.filter((x) => x.state === "Uploaded").length;
      setUploadMeter(
        `${done} of ${rows.length} photos saved · ${(bytesSent / 1048576).toFixed(1)} MB sent this run · ${((bytesSent * 8) / elapsed / 1000000).toFixed(1)} Mbps average · ${Math.round(elapsed)}s elapsed`,
      );
      setBatch([...rows]);
    };
    const progress = (row: any, kind: string, n: number) => {
      const key = row.id + kind;
      transferred.set(key, Math.max(transferred.get(key) || 0, n));
      refresh();
    };
    const stage = (row: any, text: string) => {
      row.state = text;
      refresh(true);
    };
    const timer = window.setInterval(() => refresh(true), 1000);
    const prepare = async (row: any) => {
      try {
        controller.signal.throwIfAborted();
        const options: any = {
          access: "private",
          handleUploadUrl: "/api/admin/upload",
          clientPayload: JSON.stringify({ id: job.id, token: job.token }),
          multipart: true,
          abortSignal: controller.signal,
        };
        if (!row.proofDone) {
          stage(row, "Making proof");
          const proof = await makeProof(row.file);
          controller.signal.throwIfAborted();
          stage(row, "Uploading proof");
          await upload(`media/${job.id}/${row.id}/proof`, proof, {
            ...options,
            contentType: "image/jpeg",
            onUploadProgress: (p: any) => progress(row, "proof", p.loaded),
          });
          progress(row, "proof", proof.size);
          row.proofDone = true;
        }
        if (job.high_res !== false && !row.originalDone)
          await uploadOriginal(
            job,
            row.id,
            row.file,
            row,
            controller.signal,
            (n) => progress(row, "original", n),
            (text) => stage(row, text),
            sessionQueue,
          );
        stage(row, "Waiting to save");
        return { row, error: null };
      } catch (error: any) {
        stage(
          row,
          controller.signal.aborted ? "Stopped" : "Stopped: " + error.message,
        );
        return { row, error };
      }
    };
    const inFlight = new Map<number, Promise<any>>();
    let failure: any = null;
    try {
      if (remaining[0]) inFlight.set(0, prepare(remaining[0]));
      if (remaining[1]) inFlight.set(1, prepare(remaining[1]));
      for (let i = 0; i < remaining.length; i++) {
        const result = await inFlight.get(i)!;
        if (result.error) {
          failure = result.error;
          controller.abort();
          break;
        }
        controller.signal.throwIfAborted();
        const row = result.row;
        stage(row, "Verifying and saving");
        try {
          await api("galleries/" + job.id + "/photos", "POST", {
            photoId: row.id,
            title: row.title,
            filename: row.file.name,
            hasOriginal: job.high_res !== false,
          });
          stage(row, "Uploaded");
        } catch (error: any) {
          stage(row, "Stopped: " + error.message);
          failure = error;
          controller.abort();
          break;
        }
        if (remaining[i + 2]) inFlight.set(i + 2, prepare(remaining[i + 2]));
      }
      await Promise.all(inFlight.values());
      if (failure) throw failure;
      controller.signal.throwIfAborted();
      setBatchPublish("publishing");
      setUploadMeter((old) => old + " · Publishing gallery...");
      try {
        await publishGallery(job);
        setBatchPublish("published");
        setStatus("Photos uploaded. Gallery is live.");
      } catch (e: any) {
        setBatchPublish("failed");
        await load();
        throw Error(
          "Photos uploaded, but automatic publishing failed: " +
            e.message +
            " Tap Retry publishing.",
        );
      }
    } catch (e: any) {
      controller.abort();
      await Promise.all(inFlight.values());
      await load();
      setBatch([...rows]);
      if (
        String(e.message).startsWith(
          "Photos uploaded, but automatic publishing failed:",
        )
      )
        throw e;
      throw Error(
        failure
          ? "Upload paused: " +
              failure.message +
              " Completed photos stay saved. Tap Retry without closing this page."
          : "Upload stopped. Completed photos stay saved. Tap Retry without closing this page.",
      );
    } finally {
      clearInterval(timer);
      refresh(true);
      uploadController.current = null;
      setUploading(false);
    }
  }
  const renderGallery = (g: any) => (
    <article
      key={g.id}
      style={{ borderTop: "1px solid #e3e0d9", padding: "10px 0" }}
    >
      <div style={{ display: "flex", gap: 12, alignItems: "flex-start" }}>
        <button
          type="button"
          disabled={busy}
          aria-expanded={expanded === g.id}
          aria-controls={"controls-" + g.id}
          style={{
            display: "flex",
            alignItems: "flex-start",
            gap: 12,
            flex: 1,
            minWidth: 0,
            border: 0,
            padding: "10px 0",
            textAlign: "left",
            margin: 0,
          }}
          onClick={() => {
            if (
              active &&
              (active.id !== g.id || expanded === g.id) &&
              needsUpdate[active.id] &&
              !window.confirm(
                "This gallery has changes since its last Update. Tap Update gallery to confirm publication and refresh its share preview. Leave anyway?",
              )
            )
              return;
            if (
              active &&
              (active.id !== g.id || expanded === g.id) &&
              galleryDirty(active.id) &&
              !window.confirm("Unsaved changes. Leave without saving?")
            )
              return;
            if (
              active?.id !== g.id &&
              Object.keys(titleEdits).length &&
              !window.confirm(
                "You have unsaved title edits. Save before leaving. Leave anyway?",
              )
            )
              return;
            if (active?.id !== g.id) setTitleEdits({});
            if (expanded === g.id) {
              setExpanded(null);
              setDeleteConfirm(null);
              return;
            }
            if (
              active?.id !== g.id &&
              batch.some((x) => x.state !== "Uploaded")
            ) {
              setStatus(
                "Finish this upload or tap its X before opening another gallery.",
              );
              return;
            }
            if (active?.id !== g.id) setBatch([]);
            setDeleteConfirm(null);
            setActive(g);
            setLink(location.origin + g.path);
            setSettingsTab("look");
            setExpanded(g.id);
          }}
        >
          <span aria-hidden="true" style={{ flexShrink: 0 }}>
            {expanded === g.id ? "▼" : "▶"}
          </span>
          <span style={{ minWidth: 0, display: "block" }}>
            <span
              style={{
                display: "flex",
                gap: 12,
                alignItems: "flex-start",
                justifyContent: "space-between",
              }}
            >
              <strong
                style={{
                  display: "block",
                  overflowWrap: "anywhere",
                  lineHeight: 1.3,
                }}
              >
                {g.title}
              </strong>
            </span>
            <span
              style={{
                display: "block",
                fontSize: 20,
                lineHeight: 1.5,
                marginTop: 5,
              }}
            >
              {g.photo_count} photos · {g.published ? "Live" : "Draft"} ·{" "}
              <span
                aria-label={g.heart_count + " hearted images"}
                style={{ color: "#000" }}
              >
                <span
                  aria-hidden="true"
                  style={{ fontFamily: "Arial,sans-serif" }}
                >
                  ♥︎
                </span>{" "}
                {g.heart_count}
              </span>
            </span>
            <span
              style={{
                display: "block",
                fontSize: 17,
                lineHeight: 1.4,
                marginTop: 6,
                color: "#526347",
              }}
            >
              Viewed {g.view_count ?? 0}{" "}
              {(g.view_count ?? 0) === 1 ? "time" : "times"}
            </span>
            {g.view_count > 0 && (
              <span
                style={{
                  display: "block",
                  fontSize: 14,
                  lineHeight: 1.4,
                  color: "#666",
                }}
              >
                First: {new Date(g.first_viewed_at).toLocaleString()}
                <br />
                Last: {new Date(g.last_viewed_at).toLocaleString()}
              </span>
            )}
            {g.noteCount > 0 && (
              <span
                style={{
                  display: "inline-block",
                  marginTop: 8,
                  padding: "4px 10px",
                  border: "2px solid #355800",
                  borderRadius: 6,
                  background: "#edf4de",
                  color: "#173b28",
                  fontSize: 18,
                  fontWeight: 700,
                }}
              >
                ✎ {g.noteCount} client {g.noteCount === 1 ? "note" : "notes"} ·{" "}
                {g.notePhotos.length}{" "}
                {g.notePhotos.length === 1 ? "image" : "images"}
              </span>
            )}
            {g.noteError && (
              <span
                style={{ display: "block", color: "#8b2020", fontSize: 18 }}
              >
                Client notes unavailable. Tap Refresh to retry.
              </span>
            )}
          </span>
        </button>
        <a
          href={location.origin + g.path.split("?")[0]}
          target="_blank"
          rel="noreferrer"
          onClick={(e) => e.stopPropagation()}
          style={{
            flexShrink: 0,
            fontSize: 18,
            padding: "5px 10px",
            border: "1px solid #173b28",
            borderRadius: 4,
            textDecoration: "none",
          }}
        >
          Open
        </a>
      </div>
      <input
        type="text"
        readOnly
        aria-label={"Client URL for " + g.title}
        value={location.origin + g.path.split("?")[0]}
        title={location.origin + g.path.split("?")[0]}
        onFocus={(e) => e.currentTarget.select()}
        onClick={(e) => e.currentTarget.select()}
        style={{
          display: "block",
          width: "calc(100% - 36px)",
          minWidth: 0,
          boxSizing: "border-box",
          margin: "0 0 12px 36px",
          fontSize: 20,
          textOverflow: "ellipsis",
          whiteSpace: "nowrap",
          overflow: "hidden",
          background: "#f8f8f6",
          color: "#173b28",
        }}
      />
      {expanded === g.id && active?.id === g.id && (
        <div id={"controls-" + g.id} style={{ paddingTop: 8 }}>
          {active.noteCount > 0 && (
            <section
              aria-label={"Client notes for " + active.title}
              style={{
                margin: "8px 0 24px",
                padding: 16,
                border: "2px solid #355800",
                borderRadius: 6,
                background: "#f4f8ec",
                color: "#173b28",
              }}
            >
              <h3 style={{ margin: "0 0 16px", fontSize: 22 }}>
                Client notes ({active.noteCount})
              </h3>
              {active.notePhotos.map((p: any) => (
                <article
                  key={p.id}
                  style={{ borderTop: "1px solid #b3c497", padding: "16px 0" }}
                >
                  <div
                    style={{
                      display: "flex",
                      gap: 12,
                      alignItems: "flex-start",
                    }}
                  >
                    {active.published && (
                      <img
                        src={
                          "/api/galleries/" +
                          active.proofKey +
                          "/media/" +
                          p.id +
                          "/proof"
                        }
                        alt={"Photo: " + (p.title || p.filename)}
                        loading="lazy"
                        style={{
                          width: 72,
                          height: 72,
                          objectFit: "contain",
                          background: "#fff",
                          borderRadius: 4,
                          flexShrink: 0,
                        }}
                      />
                    )}
                    <div style={{ minWidth: 0 }}>
                      <strong
                        style={{ display: "block", overflowWrap: "anywhere" }}
                      >
                        {p.title || p.filename}
                      </strong>
                      {p.title && (
                        <span
                          style={{
                            display: "block",
                            fontSize: 16,
                            overflowWrap: "anywhere",
                          }}
                        >
                          {p.filename}
                        </span>
                      )}
                      <span
                        style={{
                          display: "inline-block",
                          fontSize: 18,
                          fontWeight: 700,
                          marginTop: 4,
                        }}
                      >
                        ✎ {p.comments.length}{" "}
                        {p.comments.length === 1 ? "note" : "notes"}
                      </span>
                    </div>
                  </div>
                  {p.comments.map((n: any) => (
                    <div
                      key={n.id}
                      style={{
                        marginTop: 12,
                        padding: 12,
                        background: "#fff",
                        borderLeft: "4px solid #355800",
                      }}
                    >
                      <p
                        style={{
                          margin: 0,
                          whiteSpace: "pre-wrap",
                          overflowWrap: "anywhere",
                          fontSize: 20,
                          lineHeight: 1.5,
                        }}
                      >
                        {n.text}
                      </p>
                      {n.created_at && (
                        <time
                          style={{
                            display: "block",
                            marginTop: 8,
                            fontSize: 15,
                            color: "#526347",
                          }}
                          dateTime={new Date(n.created_at).toISOString()}
                        >
                          {new Date(n.created_at).toLocaleString()}
                        </time>
                      )}
                    </div>
                  ))}
                </article>
              ))}
              <p style={{ fontSize: 16, margin: "12px 0 0" }}>
                Tap Refresh above to check for new client notes.
              </p>
            </section>
          )}
          {needsUpdate[g.id] && !uploading && (
            <p className="adminmessage" role="status">
              Saved. Tap Update gallery to refresh the share preview.
            </p>
          )}
          <nav className="admintabs" aria-label="Gallery settings">
            {["look", "downloads", "photos"].map((tab) => (
              <button
                key={tab}
                type="button"
                aria-selected={settingsTab === tab}
                disabled={busy}
                onClick={() => setSettingsTab(tab)}
              >
                {tab[0].toUpperCase() + tab.slice(1)}
              </button>
            ))}
          </nav>
          <section className="cleanpanel" hidden={settingsTab !== "look"}>
            <h3>Contact sheet</h3>
            <div className="adminpick" aria-label="Contact sheet style">
              {["dark", "light", "masonry"].map((theme) => (
                <button
                  key={theme}
                  type="button"
                  disabled={busy}
                  aria-pressed={
                    (settingsDrafts[active.id]?.theme ??
                      active.theme ??
                      "dark") === theme
                  }
                  onClick={() => editSetting("theme", theme)}
                >
                  <span className={"sheetswatch " + theme} />
                  {theme === "dark"
                    ? "Dark"
                    : theme === "light"
                      ? "Light"
                      : "Masonry"}
                </button>
              ))}
            </div>
            <div className="waxpicker">
              <label className="check">
                <input
                  type="checkbox"
                  checked={
                    (settingsDrafts[active.id]?.wax_marks ??
                      active.wax_marks) === true
                  }
                  disabled={busy}
                  onChange={(e) => editSetting("wax_marks", e.target.checked)}
                />
                Wax pencil
              </label>
              <div className="waxdots">
                {["red", "white"].map((color) => (
                  <button
                    key={color}
                    type="button"
                    aria-label={color === "red" ? "Red" : "White"}
                    aria-pressed={
                      (settingsDrafts[active.id]?.wax_color ??
                        active.wax_color ??
                        "red") === color
                    }
                    disabled={
                      busy ||
                      (settingsDrafts[active.id]?.wax_marks ??
                        active.wax_marks) !== true
                    }
                    onClick={() => editSetting("wax_color", color)}
                  >
                    <span className={color} />
                  </button>
                ))}
              </div>
            </div>
            <p className="cleanhelp">
              Marks on the sheet only. Photos stay unchanged.
            </p>
            <details>
              <summary>Name &amp; website</summary>
              <label>
                Photographer name
                <input
                  maxLength={100}
                  value={
                    settingsDrafts[active.id]?.photographer ??
                    active.photographer ??
                    ""
                  }
                  disabled={busy}
                  onChange={(e) => editSetting("photographer", e.target.value)}
                  placeholder="Optional"
                />
              </label>
              <label>
                Website
                <input
                  maxLength={2048}
                  value={
                    settingsDrafts[active.id]?.website ?? active.website ?? ""
                  }
                  disabled={busy}
                  onChange={(e) => editSetting("website", e.target.value)}
                  placeholder="https://your-site.com"
                />
              </label>
              <label className="check">
                <input
                  type="checkbox"
                  checked={
                    (settingsDrafts[active.id]?.show_website ??
                      active.show_website) !== false &&
                    !!(
                      settingsDrafts[active.id]?.website ??
                      active.website ??
                      ""
                    ).trim()
                  }
                  disabled={
                    busy ||
                    !(
                      settingsDrafts[active.id]?.website ??
                      active.website ??
                      ""
                    ).trim()
                  }
                  onChange={(e) =>
                    editSetting("show_website", e.target.checked)
                  }
                />
                Show website
              </label>
              <p className="cleanhelp">Leave blank to keep the header clean.</p>
            </details>
            <label className="check">
              <input
                type="checkbox"
                checked={
                  (settingsDrafts[active.id]?.watermark ?? active.watermark) ===
                  true
                }
                disabled={busy}
                onChange={(e) => editSetting("watermark", e.target.checked)}
              />
              Watermark
            </label>
            <p className="cleanhelp">
              Proofs and web downloads only. Hi-res stays clean.
            </p>
            {(settingsDrafts[active.id]?.watermark ?? active.watermark) ===
              true && (
              <details>
                <summary>Watermark options</summary>
                <div className="adminpick" aria-label="Watermark type">
                  {[
                    ["text", "Text"],
                    ["logo", "Logo"],
                  ].map(([value, label]) => (
                    <button
                      key={value}
                      type="button"
                      disabled={busy}
                      aria-pressed={
                        (settingsDrafts[active.id]?.watermark_type ??
                          active.watermark_type ??
                          "text") === value
                      }
                      onClick={() => editSetting("watermark_type", value)}
                    >
                      {label}
                    </button>
                  ))}
                </div>
                {(settingsDrafts[active.id]?.watermark_type ??
                  active.watermark_type ??
                  "text") === "text" ? (
                  <label>
                    Watermark text
                    <input
                      aria-label="Watermark text"
                      maxLength={100}
                      placeholder={
                        settingsDrafts[active.id]?.photographer ??
                        active.photographer ??
                        active.title
                      }
                      value={
                        settingsDrafts[active.id]?.watermark_text ??
                        active.watermark_text ??
                        ""
                      }
                      disabled={busy}
                      onChange={(e) =>
                        editSetting("watermark_text", e.target.value)
                      }
                    />
                    <small>
                      Blank uses your photographer name, or gallery title.
                    </small>
                  </label>
                ) : (
                  <p className="cleanhelp">Uses your current gallery logo.</p>
                )}
                <div className="adminpick" aria-label="Watermark placement">
                  {[
                    ["corner", "Small corner"],
                    ["diagonal", "Large diagonal"],
                  ].map(([value, label]) => (
                    <button
                      key={value}
                      type="button"
                      disabled={busy}
                      aria-pressed={
                        (settingsDrafts[active.id]?.watermark_placement ??
                          active.watermark_placement ??
                          "corner") === value
                      }
                      onClick={() => editSetting("watermark_placement", value)}
                    >
                      {label}
                    </button>
                  ))}
                </div>
                <p className="cleanhelp">
                  A light mark. Originals are never changed.
                </p>
              </details>
            )}
            <details>
              <summary>Brand colors &amp; fonts</summary>
              <p className="cleanhelp">
                For this gallery header only. Photos stay unchanged.
              </p>
              <div className="brandcolorrow">
                <label>
                  Accent color
                  <input
                    aria-label="Accent color"
                    type="color"
                    value={
                      settingsDrafts[active.id]?.brand_accent === null
                        ? "#173b28"
                        : (settingsDrafts[active.id]?.brand_accent ??
                          active.brand_accent ??
                          "#173b28")
                    }
                    disabled={busy}
                    onChange={(e) =>
                      editSetting("brand_accent", e.target.value)
                    }
                  />
                </label>
                <label>
                  Header text
                  <input
                    aria-label="Header text color"
                    type="color"
                    value={
                      settingsDrafts[active.id]?.header_color === null
                        ? "#121212"
                        : (settingsDrafts[active.id]?.header_color ??
                          active.header_color ??
                          "#121212")
                    }
                    disabled={busy}
                    onChange={(e) =>
                      editSetting("header_color", e.target.value)
                    }
                  />
                </label>
              </div>
              <div className="adminpick" aria-label="Header font">
                {[
                  ["archivo", "Bold"],
                  ["assistant", "Clean"],
                  ["serif", "Classic"],
                ].map(([value, label]) => (
                  <button
                    key={value}
                    type="button"
                    disabled={busy}
                    aria-pressed={
                      (settingsDrafts[active.id]?.header_font === null
                        ? "archivo"
                        : (settingsDrafts[active.id]?.header_font ??
                          active.header_font ??
                          "archivo")) === value
                    }
                    onClick={() => editSetting("header_font", value)}
                  >
                    {label}
                  </button>
                ))}
              </div>
              <div className="brandpreview" aria-label="Header preview">
                <div
                  className="brandpreviewtitle"
                  style={
                    {
                      color:
                        settingsDrafts[active.id]?.header_color === null
                          ? "#121212"
                          : (settingsDrafts[active.id]?.header_color ??
                            active.header_color ??
                            "#121212"),
                      "--brand-preview-font":
                        (settingsDrafts[active.id]?.header_font === null
                          ? "archivo"
                          : (settingsDrafts[active.id]?.header_font ??
                            active.header_font)) === "assistant"
                          ? "Broach Assistant,sans-serif"
                          : (settingsDrafts[active.id]?.header_font === null
                                ? "archivo"
                                : (settingsDrafts[active.id]?.header_font ??
                                  active.header_font)) === "serif"
                            ? "Georgia,serif"
                            : "Broach Archivo Black,sans-serif",
                    } as React.CSSProperties
                  }
                >
                  {active.title}
                </div>
                <p
                  style={{
                    color:
                      settingsDrafts[active.id]?.header_color === null
                        ? "#444"
                        : (settingsDrafts[active.id]?.header_color ??
                          active.header_color ??
                          "#444"),
                  }}
                >
                  Photography by{" "}
                  {settingsDrafts[active.id]?.photographer ??
                    active.photographer ??
                    ""}
                </p>
                <span
                  style={{
                    color:
                      settingsDrafts[active.id]?.brand_accent === null
                        ? "#173b28"
                        : (settingsDrafts[active.id]?.brand_accent ??
                          active.brand_accent ??
                          "#173b28"),
                    textDecoration: "underline",
                  }}
                >
                  Your website
                </span>
              </div>
              <p className="cleanhelp">
                Choose colors that are easy to read on the white header.
              </p>
              <button
                type="button"
                disabled={busy}
                onClick={() =>
                  setSettingsDrafts((old) => ({
                    ...old,
                    [active.id]: {
                      ...old[active.id],
                      brand_accent: null,
                      header_color: null,
                      header_font: null,
                    },
                  }))
                }
              >
                Reset to default
              </button>
            </details>
          </section>
          <section className="cleanpanel" hidden={settingsTab !== "downloads"}>
            <h3>Client downloads</h3>
            <div className="adminpick" aria-label="Client downloads">
              {["off", "web", "hires"].map((mode) => (
                <button
                  type="button"
                  key={mode}
                  disabled={
                    busy ||
                    (mode === "hires" &&
                      ((settingsDrafts[active.id]?.high_res ??
                        active.high_res) === false ||
                        !active.photos.some(
                          (p: any) => p.driveOriginal || p.original,
                        )))
                  }
                  aria-pressed={
                    ((settingsDrafts[active.id]?.high_res ??
                      active.high_res) !== false &&
                    (settingsDrafts[active.id]?.downloads ??
                      active.downloads) &&
                    active.photos.some(
                      (p: any) => p.driveOriginal || p.original,
                    )
                      ? "hires"
                      : (settingsDrafts[active.id]?.web_downloads ??
                            active.web_downloads) === true
                        ? "web"
                        : "off") === mode
                  }
                  onClick={() =>
                    setSettingsDrafts((old) => ({
                      ...old,
                      [active.id]: {
                        ...old[active.id],
                        downloads: mode === "hires",
                        web_downloads: mode === "web",
                      },
                    }))
                  }
                >
                  {mode === "off" ? "Off" : mode === "web" ? "Web" : "Hi-res"}
                  {mode !== "off" && (
                    <small>{mode === "web" ? "For social" : "For print"}</small>
                  )}
                </button>
              ))}
            </div>
            <p className="cleanhelp">
              {!active.photos.some((p: any) => p.driveOriginal || p.original)
                ? "No hi-res originals uploaded. Web size is available."
                : (settingsDrafts[active.id]?.high_res ?? active.high_res) ===
                    false
                  ? "Turn on originals below to enable hi-res delivery."
                  : "Web copies save with -web in the filename."}
            </p>
            <label className="check">
              <input
                type="checkbox"
                checked={
                  (settingsDrafts[active.id]?.high_res ?? active.high_res) !==
                  false
                }
                disabled={busy}
                onChange={(e) => editSetting("high_res", e.target.checked)}
              />
              Keep originals for new uploads
            </label>
            <p className="cleanhelp">
              Only applies to the next photos you upload.
            </p>
            {active.photos.some((p: any) => p.driveOriginal || p.original) &&
              active.photos.some(
                (p: any) => !p.driveOriginal && !p.original,
              ) && (
                <p className="cleanhelp">
                  Hi-res is available for{" "}
                  {
                    active.photos.filter(
                      (p: any) => p.driveOriginal || p.original,
                    ).length
                  }{" "}
                  of {active.photos.length} photos.
                </p>
              )}
          </section>
          <section className="cleanpanel" hidden={settingsTab !== "photos"}>
            <details ref={addPhotos}>
              <summary>Add photos</summary>
              {batch.length > 0 && (
                <>
                  <p role="status" className="adminmessage">
                    {batch.every((x) => x.state === "Uploaded")
                      ? batchPublish === "published"
                        ? "Photos uploaded. Gallery is live."
                        : batchPublish === "publishing"
                          ? "Publishing gallery..."
                          : "Photos uploaded. Publishing needs retry."
                      : busy
                        ? `Uploading ${batch.filter((x) => x.state === "Uploaded").length} of ${batch.length} photos`
                        : `${batch.length} photos ready to upload`}
                  </p>
                  {uploadMeter && !uploading && (
                    <p className="adminmessage" role="status">
                      {uploadMeter}
                    </p>
                  )}
                  <details>
                    <summary>Edit image titles before upload</summary>
                    {batch.map((row) => (
                      <label key={row.id}>
                        {row.file.name}
                        <input
                          aria-label={"Title for " + row.file.name}
                          value={row.title}
                          disabled={busy || row.state === "Uploaded"}
                          maxLength={160}
                          onChange={(e) => {
                            row.title = e.target.value;
                            setBatch([...batch]);
                          }}
                        />
                      </label>
                    ))}
                  </details>
                  {(!batch.every((x) => x.state === "Uploaded") ||
                    batchPublish === "failed") && (
                    <button
                      disabled={busy}
                      onClick={() => action(() => uploadBatch())}
                    >
                      {batchPublish === "failed"
                        ? "Retry publishing"
                        : "Upload / retry this batch"}
                    </button>
                  )}
                </>
              )}
              <div
                className="photodrop"
                onDragOver={(e) => e.preventDefault()}
                onDrop={(e) => {
                  e.preventDefault();
                  chooseBatch(e.dataTransfer.files);
                }}
              >
                <label className="check">
                  <input
                    type="checkbox"
                    checked={useNames}
                    disabled={busy}
                    onChange={(e) => {
                      setUseNames(e.target.checked);
                      setBatch((old) =>
                        old.map((row) =>
                          row.state === "Uploaded"
                            ? row
                            : {
                                ...row,
                                title: e.target.checked ? row.file.name : "",
                              },
                        ),
                      );
                    }}
                  />
                  Use file name as title
                </label>
                <label>
                  Choose photos
                  <input
                    type="file"
                    multiple
                    accept="image/jpeg,image/png,image/webp"
                    disabled={busy}
                    onChange={(e) => {
                      if (e.target.files) chooseBatch(e.target.files);
                      e.target.value = "";
                    }}
                  />
                </label>
                <p>
                  500 photos per gallery. Up to 80 MB per file and 250 MB per
                  batch.
                </p>
              </div>
            </details>
            <details>
              <summary>Edit titles ({active.photos.length})</summary>
              {active.photos.map((p: any) => (
                <label key={p.id}>
                  {p.filename}
                  <input
                    aria-label={"Uploaded title for " + p.filename}
                    value={titleEdits[p.id] ?? p.title ?? ""}
                    onChange={(e) =>
                      setTitleEdits((old) => {
                        const next = { ...old };
                        if (e.target.value === (p.title || ""))
                          delete next[p.id];
                        else next[p.id] = e.target.value;
                        return next;
                      })
                    }
                    maxLength={160}
                    disabled={busy}
                  />
                </label>
              ))}
            </details>
            <details>
              <summary>Selections</summary>
              <button
                type="button"
                disabled={busy}
                onClick={() =>
                  action(async () => {
                    setOwnerPicksMessage("Loading selections...");
                    const items = await api(
                      "galleries/" + active.id + "/picks",
                    );
                    setOwnerPicks(
                      items.map((p: any) => ({ ...p, jobId: active.id })),
                    );
                    setOwnerPicksMessage("Selections refreshed.");
                  })
                }
              >
                Refresh selections
              </button>
              <div className="adminpick filters" aria-label="Filter selections">
                {["all", "liked", "rejected", "undecided"].map((value) => (
                  <button
                    key={value}
                    type="button"
                    aria-pressed={pickFilter === value}
                    onClick={() => setPickFilter(value)}
                  >
                    {value[0].toUpperCase() + value.slice(1)}
                  </button>
                ))}
              </div>
              {ownerPicksMessage && <p role="status">{ownerPicksMessage}</p>}
              {ownerPicks
                .filter(
                  (p) =>
                    p.jobId === active.id &&
                    (pickFilter === "all" ||
                      (pickFilter === "rejected" && p.rejected) ||
                      (pickFilter === "liked" && p.hearted && !p.rejected) ||
                      (pickFilter === "undecided" &&
                        !p.hearted &&
                        !p.rejected)),
                )
                .map((p) => (
                  <p
                    key={p.id}
                    style={{ fontSize: 18, overflowWrap: "anywhere" }}
                  >
                    {p.rejected
                      ? "× Rejected"
                      : p.hearted
                        ? "♥ Liked"
                        : "Undecided"}
                    : {p.title || p.filename}
                  </p>
                ))}
            </details>
          </section>
          <details>
            <summary>More</summary>
            <details>
              <summary>
                <span>Gallery link</span>
                <button
                  style={{
                    float: "right",
                    margin: 0,
                    padding: "8px 10px",
                    fontSize: 16,
                    minHeight: 36,
                  }}
                  disabled={busy}
                  onClick={(e) => {
                    e.preventDefault();
                    e.currentTarget.closest("details")!.open = true;
                    const code = active.path
                      .split("?")[0]
                      .match(/([A-Za-z0-9_-]{22})$/)?.[1];
                    if (!code) {
                      setStatus("This gallery link could not be shortened.");
                      return;
                    }
                    setShortLinks((old) => ({
                      ...old,
                      [active.id]: location.origin + active.path,
                    }));
                  }}
                >
                  Shorten URL
                </button>
              </summary>
              {shortLinks[active.id] && (
                <p
                  style={{
                    margin: "12px 0 20px",
                    fontSize: 18,
                    lineHeight: 1.5,
                    overflowWrap: "anywhere",
                  }}
                >
                  <a
                    href={shortLinks[active.id]}
                    target="_blank"
                    rel="noreferrer"
                    aria-label={"Short URL preview for " + active.title}
                  >
                    {shortLinks[active.id]}
                  </a>
                </p>
              )}
              <p className="joblink">
                <a href={link} target="_blank" rel="noreferrer">
                  {link}
                </a>
              </p>
              {shortLinks[active.id] && (
                <label>
                  Short gallery link
                  <input
                    type="text"
                    readOnly
                    aria-label={"Short gallery link for " + active.title}
                    value={shortLinks[active.id]}
                    onFocus={(e) => e.currentTarget.select()}
                    onClick={(e) => e.currentTarget.select()}
                  />
                  <button
                    disabled={busy}
                    onClick={() =>
                      action(() =>
                        navigator.clipboard.writeText(shortLinks[active.id]),
                      )
                    }
                  >
                    Copy short link
                  </button>
                </label>
              )}
            </details>
            <p className="cleanhelp">
              Clients can view and make picks after Publish.
            </p>
            <div className="adminrow">
              <button
                disabled={busy}
                onClick={() =>
                  action(async () => {
                    await navigator.clipboard.writeText(
                      location.origin + active.path,
                    );
                  })
                }
              >
                Copy client link
              </button>
              <button
                disabled={busy}
                onClick={() =>
                  action(async () => {
                    await api("galleries/" + active.id + "/unpublish", "POST");
                    await load();
                  })
                }
              >
                Unpublish gallery
              </button>
              <button
                disabled={busy || batch.some((x) => x.state !== "Uploaded")}
                onClick={() =>
                  action(async () => {
                    await api("galleries/" + active.id + "/settings", "PATCH", {
                      admin_hidden: !active.admin_hidden,
                    });
                    setExpanded(null);
                    setDeleteConfirm(null);
                    await load();
                  })
                }
              >
                {active.admin_hidden ? "Unhide gallery" : "Hide gallery"}
              </button>
              <button
                disabled={busy}
                onClick={() => setDeleteConfirm(active.id)}
              >
                Delete gallery: {active.title}
              </button>
              {deleteConfirm === active.id && (
                <div
                  role="group"
                  aria-label="Confirm gallery deletion"
                  style={{
                    border: "2px solid #8b2020",
                    padding: 16,
                    borderRadius: 6,
                  }}
                >
                  <p>Delete "{active.title}" permanently?</p>
                  <p>
                    This removes this gallery, its photos, proofs, originals in
                    Google Drive, hearts and notes. Its client link will stop
                    working. This cannot be undone.
                  </p>
                  <button
                    disabled={busy}
                    onClick={() => setDeleteConfirm(null)}
                  >
                    Cancel
                  </button>
                  <button
                    disabled={busy}
                    style={{ background: "#8b2020", color: "#fff" }}
                    onClick={() =>
                      action(async () => {
                        await api(
                          "galleries/" + active.id + "/delete",
                          "POST",
                          { confirm: active.id },
                        );
                        setActive(null);
                        setExpanded(null);
                        setDeleteConfirm(null);
                        setBatch([]);
                        setLink("");
                        await load();
                      })
                    }
                  >
                    Yes, delete "{active.title}"
                  </button>
                </div>
              )}
            </div>
          </details>
          <button
            className="primary"
            disabled={busy || galleryDirty(active.id) || !active.photos.length}
            onClick={() =>
              action(async () => {
                await publishGallery(active);
              })
            }
          >
            {active.published ? "Update gallery" : "Publish contact sheet"}
          </button>
        </div>
      )}
    </article>
  );
  return (
    <main
      className="adminpage pfadmin"
      style={{ paddingBottom: uploading ? 300 : 120 }}
    >
      <header className="adminhead">
        <h1>Contact Sheet admin</h1>
        <button
          type="button"
          disabled={busy}
          onClick={() => {
            if (
              Object.keys(settingsDrafts).length &&
              !window.confirm("Unsaved settings will be lost. Refresh anyway?")
            )
              return;
            if (
              Object.keys(needsUpdate).length &&
              !window.confirm(
                "Gallery changes have not been confirmed with Update gallery. Refresh anyway?",
              )
            )
              return;
            if (
              Object.keys(titleEdits).length &&
              !window.confirm(
                "Unsaved title edits will be lost. Save before refreshing. Refresh anyway?",
              )
            )
              return;
            if (
              batch.some((x) => x.state !== "Uploaded") &&
              !window.confirm(
                "Refreshing clears this unfinished upload queue. Refresh anyway?",
              )
            )
              return;
            const url = new URL(location.href);
            url.searchParams.set("v", String(Date.now()));
            location.replace(url.href);
          }}
        >
          Refresh
        </button>
      </header>
      {uploading && (
        <section
          role="region"
          aria-label="Upload progress"
          style={{
            position: "fixed",
            bottom: "max(16px, env(safe-area-inset-bottom))",
            left: 16,
            right: 16,
            maxWidth: 900,
            maxHeight: "50vh",
            overflowY: "auto",
            margin: "0 auto",
            zIndex: 100,
            border: "2px solid #173b28",
            borderRadius: 8,
            background: "#f3f8f5",
            padding: 16,
            boxShadow: "0 4px 24px #0003",
            fontSize: 18,
            lineHeight: 1.4,
          }}
        >
          <div
            style={{
              display: "flex",
              gap: 12,
              alignItems: "center",
              justifyContent: "space-between",
            }}
          >
            <strong>
              {batchPublish === "publishing"
                ? "Publishing gallery"
                : "Uploading photos"}
            </strong>
            {batchPublish !== "publishing" && (
              <button
                type="button"
                onClick={stopUpload}
                aria-label="Stop uploading photos"
                style={{
                  margin: 0,
                  minHeight: 44,
                  padding: "6px 12px",
                  fontSize: 18,
                }}
              >
                Stop
              </button>
            )}
          </div>
          <p style={{ margin: "8px 0", fontSize: 18 }}>
            {batch.filter((row) => row.state === "Uploaded").length} of{" "}
            {batch.length} photos saved
          </p>
          <progress
            aria-label="Photos saved"
            value={batch.filter((row) => row.state === "Uploaded").length}
            max={Math.max(batch.length, 1)}
            style={{
              display: "block",
              width: "100%",
              height: 16,
              accentColor: "#173b28",
            }}
          />
          <p
            role="status"
            style={{ margin: "8px 0", fontSize: 18, overflowWrap: "anywhere" }}
          >
            {uploadMeter.includes(" · ")
              ? uploadMeter.split(" · ").slice(1).join(" · ")
              : uploadMeter}
          </p>
          {batchPublish !== "publishing" && (
            <div aria-label="Current upload stages">
              {batch
                .filter((row) => !["Ready", "Uploaded"].includes(row.state))
                .slice(0, 2)
                .map((row) => (
                  <div key={row.id} style={{ overflowWrap: "anywhere" }}>
                    {row.file.name}: {row.state}
                  </div>
                ))}
            </div>
          )}
        </section>
      )}
      {Object.keys(titleEdits).length > 0 && !uploading && (
        <p className="adminmessage" role="status">
          Unsaved title edits. Tap Save before leaving.
        </p>
      )}
      {status && !uploading && (!setup || setup.password || resetReady) && (
        <p role="status" className="adminmessage">
          {status}
        </p>
      )}
      {setup && !setup.password && !resetReady && (
        <section className="adminbox">
          <h2>Set up Contact Sheet</h2>
          <p>
            This is your separate installation. Your photographs stay in your
            own accounts.
          </p>
          <p>Owner: {setup.ownerEmail || "Not configured"}</p>
          <p>
            Private proof storage:{" "}
            {setup.hosting ? "Ready" : "Connect a private Vercel Blob store"}
          </p>
          <p>
            Session security:{" "}
            {setup.session ? "Ready" : "Add SESSION_SECRET in Vercel"}
          </p>
          <p>
            Google approval:{" "}
            {setup.google ? "Ready" : "Add your Google OAuth client in Vercel"}
          </p>
          <p>Callback to paste in your Google OAuth client:</p>
          <input
            readOnly
            value={
              (setup.origin || location.origin) + "/api/admin/drive/callback"
            }
            onFocus={(e) => e.currentTarget.select()}
          />
          {setup.hosting &&
            setup.session &&
            setup.google &&
            setup.ownerEmail && (
              <p>
                <a href="/api/admin/recovery">
                  Verify my Google account and choose my password
                </a>
              </p>
            )}
        </section>
      )}
      {resetReady ? (
        <section className="adminbox">
          <h2>Choose a new admin password</h2>
          <p>
            Google verified your account. This recovery expires in 10 minutes.
          </p>
          <form
            onSubmit={(e) => {
              e.preventDefault();
              if (newPassword !== confirmPassword) {
                setStatus("Passwords do not match.");
                return;
              }
              action(async () => {
                await api("recovery/reset", "POST", { newPassword });
                setNewPassword("");
                setConfirmPassword("");
                setResetReady(false);
                history.replaceState(null, "", "/admin");
                await load();
                setStatus(
                  "Password changed. Other admin sessions are signed out.",
                );
              });
            }}
          >
            <label>
              New password
              <input
                type="password"
                autoComplete="new-password"
                minLength={12}
                maxLength={256}
                required
                value={newPassword}
                onChange={(e) => setNewPassword(e.target.value)}
              />
            </label>
            <label>
              Confirm new password
              <input
                type="password"
                autoComplete="new-password"
                required
                value={confirmPassword}
                onChange={(e) => setConfirmPassword(e.target.value)}
              />
            </label>
            <p>At least 12 characters. Save it in your password manager.</p>
            <button className="primary" disabled={busy}>
              Set new password
            </button>
          </form>
        </section>
      ) : !logged ? (
        <section className="adminbox" hidden={!!setup && !setup.password}>
          <form
            onSubmit={(e) => {
              e.preventDefault();
              action(async () => {
                await api("login", "POST", { password, remember });
                setPassword("");
                await load();
              });
            }}
          >
            <label>
              Admin password
              <input
                type="password"
                autoComplete="current-password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
              />
            </label>
            <label className="check">
              <input
                type="checkbox"
                checked={remember}
                onChange={(e) => setRemember(e.target.checked)}
              />
              Remember this device for 30 days
            </label>
            <p>Use only on your own phone or computer.</p>
            <button className="primary" disabled={busy}>
              Sign in
            </button>
          </form>
          <p>
            <a href="/api/admin/recovery">
              Forgot password? Recover with Google
            </a>
          </p>
          <p style={{ fontSize: 18 }}>
            Use your configured owner Google account. Then choose a new
            password.
          </p>
        </section>
      ) : (
        <>
          <section className="adminbox">
            <h2>New gallery</h2>
            <label>
              Photographer name (optional)
              <input
                maxLength={100}
                value={newPhotographer}
                disabled={busy}
                onChange={(e) => setNewPhotographer(e.target.value)}
                placeholder="Leave blank to hide Photography by"
              />
            </label>
            <label>
              Website link (optional)
              <input
                maxLength={2048}
                value={newWebsite}
                disabled={busy}
                onChange={(e) => {
                  websiteDefaultDirty.current = true;
                  setNewWebsite(e.target.value);
                }}
                onBlur={() => {
                  if (websiteDefaultDirty.current)
                    action(async () => {
                      const d = await api("gallery-defaults", "PATCH", {
                        website: newWebsite,
                      });
                      setNewWebsite(d.website);
                      websiteDefaultDirty.current = false;
                    });
                }}
                placeholder="https://example.com"
              />
            </label>
            <label className="check">
              <input
                type="checkbox"
                checked={newShowWebsite && !!newWebsite.trim()}
                disabled={busy || !newWebsite.trim()}
                onChange={(e) => setNewShowWebsite(e.target.checked)}
              />
              Show website on new gallery
            </label>
            <p style={{ fontSize: 18 }}>
              Last saved website is remembered for new galleries. Edit it
              anytime.
            </p>
            <label>
              Contact sheet style
              <select
                value={newTheme}
                disabled={busy}
                onChange={(e) => setNewTheme(e.target.value)}
              >
                <option value="dark">Dark (original)</option>
                <option value="light">Light (white sheet)</option>
                <option value="masonry">White masonry</option>
              </select>
            </label>
            <label className="check">
              <input
                type="checkbox"
                checked={newHighRes}
                disabled={busy}
                onChange={(e) => setNewHighRes(e.target.checked)}
              />
              Upload high res for image downloads
            </label>
            <label className="check">
              <input
                type="checkbox"
                checked={useNames}
                disabled={busy}
                onChange={(e) => setUseNames(e.target.checked)}
              />
              Use file name as title
            </label>
            <label>Photos</label>
            <div
              className="photodrop"
              onDragOver={(e) => e.preventDefault()}
              onDrop={(e) => {
                e.preventDefault();
                if (!busy) {
                  setNewFiles(Array.from(e.dataTransfer.files));
                  setNaming(true);
                }
              }}
            >
              <p>Drag photos here, or tap to choose files.</p>
              <input
                aria-label="Photos for a new gallery"
                type="file"
                multiple
                accept="image/jpeg,image/png,image/webp"
                disabled={busy}
                onChange={(e) => {
                  setNewFiles(Array.from(e.target.files || []));
                  setNaming(true);
                }}
              />
              {newFiles.length > 0 && <p>{newFiles.length} photos selected</p>}
            </div>
            {!naming ? (
              <button
                className="primary"
                disabled={busy || !newFiles.length}
                onClick={() => setNaming(true)}
              >
                Upload
              </button>
            ) : (
              <form
                onSubmit={(e) => {
                  e.preventDefault();
                  action(async () => {
                    const g = await api("galleries", "POST", {
                      title,
                      client,
                      downloads: false,
                      high_res: newHighRes,
                      selling: false,
                      theme: newTheme,
                      photographer: newPhotographer,
                      website: newWebsite,
                      show_website: newShowWebsite,
                    });
                    setNewFiles([]);
                    setNaming(false);
                    setActive({ ...g, title });
                    setExpanded(g.id);
                    setLink(location.origin + g.path);
                    await load();
                    const rows = newFiles.map((file) => ({
                      file,
                      id: crypto.randomUUID(),
                      title: useNames ? file.name : "",
                      state: "Ready",
                      proofDone: false,
                      originalDone: false,
                    }));
                    setBatch(rows);
                    await uploadBatch({ ...g, title, photos: [] }, rows);
                  });
                }}
              >
                <label>
                  Gallery title
                  <input
                    required
                    maxLength={100}
                    placeholder="Name this gallery"
                    value={title}
                    onChange={(e) => setTitle(e.target.value)}
                  />
                </label>
                <label>
                  Client name (admin only)
                  <input
                    maxLength={160}
                    placeholder="Optional"
                    value={client}
                    onChange={(e) => setClient(e.target.value)}
                  />
                </label>
                <button className="primary" disabled={busy}>
                  Create gallery and upload photos
                </button>
              </form>
            )}
          </section>
          <section className="adminbox">
            <div className="overviewhead">
              <h2>Galleries</h2>
              <button disabled={busy} onClick={() => action(load)}>
                Refresh
              </button>
            </div>
            {galleries.filter((g) => !g.admin_hidden).map(renderGallery)}
            {!galleries.some((g) => !g.admin_hidden) && (
              <p>No visible galleries.</p>
            )}
            <details
              style={{
                borderTop: "1px solid #e3e0d9",
                paddingTop: 16,
                marginTop: 16,
              }}
            >
              <summary>
                Hidden galleries (
                {galleries.filter((g) => g.admin_hidden).length})
              </summary>
              <p>
                Hidden here only. Client links and published galleries stay
                live.
              </p>
              {galleries.filter((g) => g.admin_hidden).map(renderGallery)}
            </details>
            {!galleries.length && <p>No galleries yet.</p>}
          </section>
          {migration?.originals !== 0 && (
            <details
              className="adminbox"
              onToggle={(e) => {
                if (e.currentTarget.open)
                  migrationLoad().catch((e: any) =>
                    setMigrationMessage(e.message),
                  );
              }}
            >
              <summary>Move existing originals to my Google Drive</summary>
              <p>
                This keeps client links, picks and notes unchanged. Step 1
                copies and checks every original. Step 2 removes only verified
                old host copies.
              </p>
              {migration ? (
                <p>
                  {migration.originals} old host originals · {migration.copied}{" "}
                  copied · {migration.verified} verified
                </p>
              ) : (
                <p>Open this box to check existing originals.</p>
              )}
              <button disabled={busy} onClick={() => action(migrationLoad)}>
                Refresh counts
              </button>
              <button
                className="primary"
                disabled={busy || !migration || migration.originals === 0}
                onClick={() => action(() => migrate(false))}
              >
                1. Copy originals to my Google Drive and verify
              </button>
              <button
                disabled={busy || !migration?.ready_to_remove}
                onClick={() => action(() => migrate(true))}
              >
                2. Remove the old host copies (only after verification)
              </button>
              {migrationMessage && (
                <p role="status" className="adminmessage">
                  {migrationMessage}
                </p>
              )}
              {migration?.originals === 0 && (
                <p>No old host originals remain.</p>
              )}
            </details>
          )}
          <details className="adminbox storagebox">
            <summary>Google Drive setup and test</summary>
            <p>
              Originals upload directly to your private configured owner Google
              Drive. Display proofs stay with the gallery. Existing originals
              stay unchanged until migration is verified.
            </p>
            <a href="/api/admin/drive/connect">Connect Google Drive</a>
            <p>
              The test creates a private test folder and 6 MB file. It does not
              change client galleries or uploads.
            </p>
            <button
              disabled={busy}
              onClick={async () => {
                setBusy(true);
                setDriveStatus("Starting Drive storage test...");
                try {
                  await testDriveStorage(setDriveStatus);
                } catch (e: any) {
                  setDriveStatus(
                    "Drive test stopped: " +
                      (e.message || "Unexpected browser error."),
                  );
                } finally {
                  setBusy(false);
                }
              }}
            >
              Test Drive storage
            </button>
            {driveStatus && (
              <p role="status" aria-live="polite" className="adminmessage">
                {driveStatus}
              </p>
            )}
          </details>
          <details className="adminbox">
            <summary>Gallery logo</summary>
            <p>
              Replace the logo shown at the top of all client galleries.
              Existing links stay the same.
            </p>
            <img
              src={brandLogo || brandDefault}
              alt="Current gallery logo"
              style={{
                display: "block",
                maxWidth: 220,
                maxHeight: 140,
                objectFit: "contain",
                margin: "16px auto",
              }}
            />
            <label>
              Choose a logo
              <input
                type="file"
                accept="image/png,image/jpeg,image/gif,image/webp"
                disabled={busy}
                onChange={(e) => {
                  const file = e.target.files?.[0];
                  e.target.value = "";
                  if (!file) return;
                  if (file.size > 2 * 1024 * 1024) {
                    setBrandStatus("Use a logo under 2 MB.");
                    return;
                  }
                  if (
                    ![
                      "image/png",
                      "image/jpeg",
                      "image/gif",
                      "image/webp",
                    ].includes(file.type)
                  ) {
                    setBrandStatus("Use a PNG, JPEG, GIF or WebP image.");
                    return;
                  }
                  action(async () => {
                    setBrandStatus("Uploading logo...");
                    const img = new Image(),
                      url = URL.createObjectURL(file);
                    try {
                      await new Promise((resolve, reject) => {
                        img.onload = resolve;
                        img.onerror = () =>
                          reject(Error("This image could not open."));
                        img.src = url;
                      });
                      if (img.naturalWidth > 8000 || img.naturalHeight > 8000)
                        throw Error("Keep logo dimensions under 8000 pixels.");
                      const b = await api("branding/logo", "PUT", file);
                      setBrandLogo(b.logo);
                      setBrandStatus(
                        "Logo updated. Reopen or refresh a client gallery to see it.",
                      );
                    } catch (e: any) {
                      setBrandStatus(e.message);
                      throw e;
                    } finally {
                      URL.revokeObjectURL(url);
                    }
                  });
                }}
              />
            </label>
            <p style={{ fontSize: 18 }}>
              PNG, JPEG, GIF or WebP, up to 2 MB. Transparent PNG works well;
              animated GIFs keep their animation.
            </p>
            {brandStatus && <p role="status">{brandStatus}</p>}
            {brandLogo && (
              <button
                disabled={busy}
                onClick={() => {
                  if (
                    window.confirm(
                      "Restore the default Contact Sheet logo in all galleries?",
                    )
                  )
                    action(async () => {
                      await api("branding/logo", "DELETE");
                      setBrandLogo(null);
                      setBrandStatus("Original logo restored.");
                    });
                }}
              >
                Restore original logo
              </button>
            )}
          </details>
          <details className="adminbox">
            <summary>Admin password</summary>
            <p>
              Change your password here. Other admin sessions will be signed
              out. Your galleries and Google Drive connection stay unchanged.
            </p>
            <form
              onSubmit={(e) => {
                e.preventDefault();
                if (newPassword !== confirmPassword) {
                  setStatus("Passwords do not match.");
                  return;
                }
                action(async () => {
                  await api("password", "POST", {
                    currentPassword,
                    newPassword,
                  });
                  setCurrentPassword("");
                  setNewPassword("");
                  setConfirmPassword("");
                  setStatus(
                    "Password changed. Other admin sessions are signed out.",
                  );
                });
              }}
            >
              <label>
                Current password
                <input
                  type="password"
                  autoComplete="current-password"
                  maxLength={256}
                  required
                  value={currentPassword}
                  onChange={(e) => setCurrentPassword(e.target.value)}
                />
              </label>
              <label>
                New password
                <input
                  type="password"
                  autoComplete="new-password"
                  minLength={12}
                  maxLength={256}
                  required
                  value={newPassword}
                  onChange={(e) => setNewPassword(e.target.value)}
                />
              </label>
              <label>
                Confirm new password
                <input
                  type="password"
                  autoComplete="new-password"
                  required
                  value={confirmPassword}
                  onChange={(e) => setConfirmPassword(e.target.value)}
                />
              </label>
              <p>At least 12 characters. Save it in your password manager.</p>
              <button disabled={busy}>Change password</button>
            </form>
            <p>
              If you forget it, choose Recover with Google on the sign-in screen
              and use configured owner Google.
            </p>
          </details>
          <button
            disabled={busy}
            onClick={() =>
              action(async () => {
                await api("logout", "POST");
                setLogged(false);
              })
            }
          >
            Sign out
          </button>
          <canvas
            ref={canvas}
            className="previewcanvas"
            width={1200}
            height={630}
          />
        </>
      )}
      {logged && active && expanded === active.id && !uploading && (
        <footer className="adminsavebar">
          <span role="status">
            {galleryDirty(active.id) ? "Unsaved changes" : "All changes saved"}
          </span>
          <button
            type="button"
            className="primary"
            disabled={busy || !galleryDirty(active.id)}
            onClick={() => action(() => saveGallery(active))}
          >
            Save
          </button>
        </footer>
      )}
      <style>{` .pfadmin .admintabs{display:flex;gap:4px;background:#eeeae3;padding:4px;border-radius:8px;margin:16px 0}.pfadmin .admintabs button{flex:1;margin:0;padding:12px 4px;border:0;min-height:48px;background:transparent}.pfadmin .admintabs button[aria-selected=true]{background:#fff;color:#173b28;font-weight:700;border-radius:5px}.pfadmin .cleanpanel{border:1px solid #dedbd4;border-radius:10px;padding:16px;margin:16px 0;background:white}.pfadmin .cleanpanel[hidden]{display:none}.pfadmin .cleanpanel h3{font-size:20px;margin:0 0 12px}.pfadmin .cleanhelp{font-size:16px!important;line-height:1.4;color:#666;margin:8px 0 16px}.pfadmin .adminpick{display:flex;gap:8px;margin:10px 0 18px}.pfadmin .adminpick button{flex:1;min-width:0;min-height:54px;margin:0;padding:10px 6px;background:white;border:1px solid #ccc7bd;border-radius:7px;font-size:18px}.pfadmin .adminpick button[aria-pressed=true]{border:2px solid #173b28;background:#f3f8f5;color:#173b28;font-weight:700}.pfadmin .adminpick small{display:block;font-size:13px;font-weight:400;color:#666}.pfadmin .adminpick.filters{display:grid;grid-template-columns:1fr 1fr}.sheetswatch{display:block;height:46px;margin:0 2px 8px;background:#151515;border-radius:3px}.sheetswatch.light{background:#fff;border:1px solid #ddd}.sheetswatch.masonry{background:linear-gradient(90deg,#e3e3e3 45%,white 45%,white 55%,#e3e3e3 55%);position:relative}.sheetswatch.masonry:after{content:'';position:absolute;top:22px;left:0;width:45%;height:5px;background:white}.pfadmin .waxpicker{display:flex;gap:10px;align-items:center;justify-content:space-between}.pfadmin .waxpicker label{margin:0;min-height:48px}.pfadmin .waxdots{display:flex;gap:6px;flex-shrink:0}.pfadmin .waxdots button{width:48px;height:48px;border:1px solid #ccc;border-radius:50%;padding:0;margin:0;background:white}.pfadmin .waxdots button[aria-pressed=true]{border:2px solid #173b28;box-shadow:0 0 0 3px #edf4ee}.waxdots span{display:block;width:25px;height:25px;margin:auto;border-radius:50%;background:#c73027}.waxdots span.white{background:white;border:1px solid #999}.pfadmin .adminsavebar{position:fixed;bottom:0;left:0;right:0;z-index:90;background:#faf9f6;border-top:1px solid #dedbd4;padding:12px 18px max(12px,env(safe-area-inset-bottom));display:flex;align-items:center;justify-content:space-between;gap:12px}.adminsavebar span{font-size:16px;color:#666}.pfadmin .adminsavebar button{width:120px;min-height:52px;margin:0;font-size:20px}.pfadmin .brandcolorrow{display:grid;grid-template-columns:1fr 1fr;gap:12px}.pfadmin .brandcolorrow input[type=color]{height:52px;width:100%;padding:4px;cursor:pointer}.pfadmin .brandpreview{background:#f3f3f3;border:1px solid #dedbd4;border-radius:6px;padding:18px;margin:16px 0;overflow-wrap:anywhere}.pfadmin .brandpreviewtitle{font-family:var(--brand-preview-font)!important;font-size:26px;line-height:1.2;margin-bottom:12px}.pfadmin .brandpreview p{font-size:17px}.pfadmin .cleanpanel input:not([type=checkbox]){width:100%;box-sizing:border-box}.pfadmin .cleanpanel summary{min-height:48px;font-size:20px}.pfadmin button:focus-visible{outline:3px solid #355800;outline-offset:3px} `}</style>
    </main>
  );
    }
