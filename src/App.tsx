import React, { useState, useEffect, useRef } from "react";
import { useSelections } from "./selection";
import "./style.css";
import eyeLogo from "./photos/contact-sheet.png";
const samplePhotos: string[] = [];

function ProofImage({
  src,
  alt,
  ...props
}: React.ImgHTMLAttributes<HTMLImageElement>) {
  const [cycle, setCycle] = useState(0);
  const [attempt, setAttempt] = useState(0),
    [failed, setFailed] = useState(false);
  useEffect(() => {
    setAttempt(0);
    setFailed(false);
  }, [src]);
  useEffect(() => {
    if (!failed || attempt >= 2) return;
    const timer = setTimeout(
      () => {
        setFailed(false);
        setAttempt((n) => n + 1);
      },
      attempt === 0 ? 800 : 1800,
    );
    return () => clearTimeout(timer);
  }, [failed, attempt]);
  const url =
    (attempt || cycle) && src
      ? src + (src.includes("?") ? "&" : "?") + "retry=" + cycle + "-" + attempt
      : src;
  return (
    <>
      <img
        decoding="async"
        {...props}
        src={url}
        alt={alt}
        onError={() => setFailed(true)}
        onLoad={() => setFailed(false)}
      />
      {failed && attempt >= 2 && (
        <span
          role="button"
          tabIndex={0}
          aria-label={"Retry " + alt}
          style={{
            position: "absolute",
            inset: 0,
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            background: "#121212",
            color: "#fff",
            padding: 12,
            fontSize: 14,
          }}
          onClick={(e) => {
            e.stopPropagation();
            setCycle((n) => n + 1);
            setAttempt(0);
            setFailed(false);
          }}
          onKeyDown={(e) => {
            if (e.key === "Enter" || e.key === " ") {
              e.preventDefault();
              e.stopPropagation();
              setCycle((n) => n + 1);
              setAttempt(0);
              setFailed(false);
            }
          }}
        >
          Image did not load. Tap to retry.
        </span>
      )}
    </>
  );
}
function PinchPhoto({
  src,
  alt,
  onDesktopClick,
  onSwipe,
}: {
  src: string;
  alt: string;
  onDesktopClick: () => void;
  onSwipe: (step: number) => void;
}) {
  const swipe = useRef<{ x: number; y: number; time: number } | null>(null);
  const box = useRef<HTMLDivElement>(null);
  const [view, setView] = useState({ scale: 1, x: 0, y: 0 });
  const current = useRef(view);
  const gesture = useRef<{
    distance: number;
    scale: number;
    x: number;
    y: number;
    mx: number;
    my: number;
  } | null>(null);
  const lastTap = useRef(0);
  function commit(scale: number, x: number, y: number) {
    const el = box.current;
    if (!el) return;
    scale = Math.max(1, Math.min(5, scale));
    const img = el.querySelector("img");
    const ratio =
      img && img.naturalHeight ? img.naturalWidth / img.naturalHeight : 1;
    const w = Math.min(el.clientWidth, el.clientHeight * ratio),
      h = w / ratio;
    const maxX = Math.max(0, (w * scale - el.clientWidth) / 2),
      maxY = Math.max(0, (h * scale - el.clientHeight) / 2);
    const v = {
      scale,
      x: Math.max(-maxX, Math.min(maxX, x)),
      y: Math.max(-maxY, Math.min(maxY, y)),
    };
    current.current = v;
    setView(v);
  }
  function start(e: React.TouchEvent) {
    const t = e.touches,
      r = box.current!.getBoundingClientRect();
    const a = t[0],
      b = t[1] || a;
    swipe.current =
      t.length === 1 && current.current.scale === 1
        ? { x: a.clientX, y: a.clientY, time: Date.now() }
        : null;
    gesture.current = {
      distance:
        t.length > 1
          ? Math.hypot(a.clientX - b.clientX, a.clientY - b.clientY)
          : 0,
      ...current.current,
      mx: (a.clientX + b.clientX) / 2 - r.left - r.width / 2,
      my: (a.clientY + b.clientY) / 2 - r.top - r.height / 2,
    };
  }
  function moveTouch(e: React.TouchEvent) {
    e.preventDefault();
    const g = gesture.current;
    if (!g) return;
    const t = e.touches,
      r = box.current!.getBoundingClientRect(),
      a = t[0],
      b = t[1] || a;
    const mx = (a.clientX + b.clientX) / 2 - r.left - r.width / 2,
      my = (a.clientY + b.clientY) / 2 - r.top - r.height / 2;
    if (t.length > 1) swipe.current = null;
    if (t.length > 1 && g.distance) {
      const scale = Math.max(
        1,
        Math.min(
          5,
          (g.scale * Math.hypot(a.clientX - b.clientX, a.clientY - b.clientY)) /
            g.distance,
        ),
      );
      const k = scale / g.scale;
      commit(scale, mx - (g.mx - g.x) * k, my - (g.my - g.y) * k);
    } else if (t.length === 1)
      commit(g.scale, g.x + mx - g.mx, g.y + my - g.my);
  }
  function end(e: React.TouchEvent) {
    const s = swipe.current;
    swipe.current = null;
    if (!e.touches.length && s && current.current.scale === 1) {
      const t = e.changedTouches[0],
        dx = t.clientX - s.x,
        dy = t.clientY - s.y;
      if (
        Math.abs(dx) > 60 &&
        Math.abs(dx) > Math.abs(dy) * 1.5 &&
        Date.now() - s.time < 800
      )
        onSwipe(dx < 0 ? 1 : -1);
    }
    if (e.touches.length) start(e);
    else gesture.current = null;
  }
  return (
    <div
      ref={box}
      className="imageviewport pinchphoto"
      onTouchStart={start}
      onTouchMove={moveTouch}
      onTouchEnd={end}
      onTouchCancel={() => {
        gesture.current = null;
        swipe.current = null;
      }}
    >
      <ProofImage
        src={src}
        alt={alt}
        draggable={false}
        style={{
          transform: `translate(${view.x}px, ${view.y}px) scale(${view.scale})`,
        }}
        onClick={() => {
          if (window.matchMedia("(pointer:coarse)").matches) {
            const now = Date.now();
            if (now - lastTap.current < 300) commit(1, 0, 0);
            lastTap.current = now;
          } else onDesktopClick();
        }}
      />
    </div>
  );
}
function ImageNotes({
  token,
  photoId,
  onCount,
}: {
  token: string;
  photoId: string;
  onCount: (n: number) => void;
}) {
  const [notes, setNotes] = useState<any[]>([]),
    [text, setText] = useState(""),
    [busy, setBusy] = useState(false),
    [message, setMessage] = useState("");
  const pending = useRef<string | null>(null);
  const box = useRef<HTMLDetailsElement>(null);
  useEffect(() => {
    let live = true;
    fetch(`/api/galleries/${token}/comments/${photoId}`)
      .then((r) => {
        if (!r.ok) throw Error("Notes could not load.");
        return r.json();
      })
      .then((x) => {
        if (live) {
          setNotes(x);
          onCount(x.length);
          if (x.length && box.current) box.current.open = true;
        }
      })
      .catch((e) => {
        if (live) setMessage(e.message);
      });
    return () => {
      live = false;
    };
  }, [token, photoId]);
  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!text.trim() || busy) return;
    setBusy(true);
    setMessage("");
    try {
      pending.current ||= crypto.randomUUID();
      const r = await fetch(`/api/galleries/${token}/comments/${photoId}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id: pending.current, text }),
      });
      const note = await r.json();
      if (!r.ok) throw Error(note.error || "Note could not save.");
      setNotes((old) =>
        old.some((x) => x.id === note.id) ? old : [...old, note],
      );
      setText("");
      pending.current = null;
      onCount(
        notes.some((n) => n.id === note.id) ? notes.length : notes.length + 1,
      );
      if (box.current) box.current.open = true;
      setMessage("Note saved.");
    } catch (e: any) {
      setMessage(e.message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <details ref={box} className="imagenotes">
      <summary>
        {notes.length ? `Notes (${notes.length})` : "Add a note"}
      </summary>
      {notes.map((n) => (
        <p key={n.id} className="imagenote">
          {n.text}
        </p>
      ))}
      <form onSubmit={submit}>
        <label>
          Note about this image
          <textarea
            maxLength={2000}
            rows={3}
            value={text}
            onChange={(e) => {
              setText(e.target.value);
              pending.current = null;
            }}
            placeholder="What should David know about this image?"
          />
        </label>
        <button disabled={busy || !text.trim()}>Save note</button>
        {message && <p role="status">{message}</p>}
      </form>
    </details>
  );
}
export function App() {
  const [noteCounts, setNoteCounts] = useState<Record<string, number>>({});
  const [logo, setLogo] = useState<string | null>(null);
  useEffect(() => {
    fetch("/api/app/branding", { cache: "no-store" })
      .then((r) => (r.ok ? r.json() : {}))
      .then((b) => setLogo(b.logo || null))
      .catch(() => {});
  }, []);
  const [downloads, setDownloads] = useState(true);
  const [gallery, setGallery] = useState<any>(null),
    [error, setError] = useState("");
  const galleryToken = location.pathname.startsWith("/p/")
    ? document.querySelector<HTMLMetaElement>(
        'meta[name="broach-gallery-token"]',
      )?.content || location.pathname.split("/")[2]
    : null;
  const openReported = useRef(false);
  useEffect(() => {
    if (!galleryToken || !gallery || openReported.current) return;
    const report = () => {
      if (document.visibilityState !== "visible" || openReported.current)
        return;
      openReported.current = true;
      fetch(`/api/galleries/${galleryToken}/open`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: "{}",
        keepalive: true,
      }).catch(() => {});
    };
    report();
    document.addEventListener("visibilitychange", report);
    return () => document.removeEventListener("visibilitychange", report);
  }, [galleryToken, gallery]);
  useEffect(() => {
    if (galleryToken)
      fetch(`/api/galleries/${galleryToken}`)
        .then((r) => {
          if (!r.ok) throw Error("This gallery is unavailable.");
          return r.json();
        })
        .then(setGallery)
        .catch((e) => setError(e.message));
  }, []);
  const photos = gallery
    ? gallery.photos.map(
        (p: any) =>
          `/api/galleries/${galleryToken}/media/${p.id}/proof?wm=${encodeURIComponent(gallery.watermark_version || "")}`,
      )
    : samplePhotos;
  const [favorites, setSelection, favoriteStorage, rejected] = useSelections(
    gallery,
    galleryToken,
  );
  const [selectionFilter, setSelectionFilter] = useState("all");
  const waxOn = gallery?.wax_marks === true;
  const waxColor = gallery?.wax_color === "white" ? "#fff" : "#e53935";
  const visibleIndices = photos
    .map((_: any, i: number) => i)
    .filter(
      (i: number) =>
        selectionFilter === "all" ||
        (selectionFilter === "liked" && favorites.includes(i)) ||
        (selectionFilter === "rejected" && rejected.includes(i)) ||
        (selectionFilter === "undecided" &&
          !favorites.includes(i) &&
          !rejected.includes(i)),
    );
  function imageTitle(i: number) {
    return gallery
      ? gallery.photos[i].title
      : `Sample frame ${String(i + 1).padStart(2, "0")}`;
  }
  function filename(i: number) {
    return gallery ? gallery.photos[i].filename : `sample-frame-${i + 1}.jpg`;
  }
  function original(i: number) {
    return gallery
      ? `/api/galleries/${galleryToken}/media/${gallery.photos[i].id}/original`
      : photos[i];
  }
  async function saveWebCopy(
    e: React.MouseEvent<HTMLAnchorElement>,
    i: number,
  ) {
    const name = filename(i),
      ext = name.match(/\.([^.]+)$/)?.[1]?.toLowerCase();
    if (["jpg", "jpeg"].includes(ext || "")) return;
    e.preventDefault();
    setImageShareMessage("Preparing web-size copy...");
    try {
      const response = await fetch(
        `/api/galleries/${galleryToken}/media/${gallery.photos[i].id}/web`,
      );
      if (!response.ok) throw Error("Web-size download is unavailable.");
      const bitmap = await createImageBitmap(await response.blob()),
        canvas = document.createElement("canvas");
      canvas.width = bitmap.width;
      canvas.height = bitmap.height;
      canvas.getContext("2d")!.drawImage(bitmap, 0, 0);
      bitmap.close();
      const type =
        ext === "png" ? "image/png" : ext === "webp" ? "image/webp" : null;
      if (!type)
        throw Error(
          "This file format cannot be saved with its original extension.",
        );
      const blob = await new Promise<Blob>((resolve, reject) =>
        canvas.toBlob(
          (b) =>
            b && b.type === type
              ? resolve(b)
              : reject(Error("Your browser cannot save this image format.")),
          type,
          0.86,
        ),
      );
      const url = URL.createObjectURL(blob),
        a = document.createElement("a");
      a.href = url;
      a.download = /\.[^.]+$/.test(name)
        ? name.replace(/(\.[^.]*)$/, "-web$1")
        : name + "-web";
      a.click();
      setTimeout(() => URL.revokeObjectURL(url), 60000);
      setImageShareMessage("Web-size copy ready. Not the original print file.");
    } catch (e: any) {
      setImageShareMessage(e.message || "Web-size copy could not save.");
    }
  }
  async function zipDownload() {
    setError("");
    try {
      const { zipSync } = await import("fflate");
      const files: any = {};
      let bytes = 0;
      for (let i = 0; i < photos.length; i++) {
        if (gallery && !gallery.photos[i].has_original) continue;
        const r = await fetch(original(i));
        if (!r.ok) throw Error("A download could not be loaded.");
        const data = new Uint8Array(await r.arrayBuffer());
        bytes += data.length;
        if (bytes > 150 * 1024 * 1024)
          throw Error(
            "This gallery is too large to package on your device. Download images individually.",
          );
        files[String(i + 1).padStart(2, "0") + "-" + filename(i)] = data;
      }
      if (!Object.keys(files).length)
        throw Error("No originals have been uploaded.");
      const url = URL.createObjectURL(
        new Blob([zipSync(files, { level: 0 })], { type: "application/zip" }),
      );
      const a = document.createElement("a");
      a.href = url;
      a.download = (gallery?.title || "sample-job") + ".zip";
      a.click();
      setTimeout(() => URL.revokeObjectURL(url), 10000);
    } catch (e: any) {
      setError(e.message);
    }
  }
  function toggleFavorite(i: number) {
    if (favoriteStorage.ready)
      setSelection(i, favorites.includes(i) ? "undecided" : "liked");
  }
  function heart(i: number, large = false) {
    const selected = favorites.includes(i);
    return (
      <button
        className={`favorite ${selected ? "ishearted" : ""} ${large ? "largeheart" : ""}`}
        aria-label={`${selected ? "Unheart" : "Heart"} ${imageTitle(i)}`}
        aria-pressed={selected}
        disabled={!favoriteStorage.ready}
        onClick={() => toggleFavorite(i)}
      >
        <svg viewBox="0 0 24 24" aria-hidden="true">
          <path d="M12 20.3 3.3 12C-2 6.8 5.4-.6 12 6.4 18.6-.6 26 6.8 20.7 12Z" />
        </svg>
      </button>
    );
  }
  function reject(i: number, large = false) {
    const selected = rejected.includes(i);
    return (
      <button
        type="button"
        className={`favorite reject ${selected ? "isrejected" : ""} ${large ? "largeheart" : ""}`}
        aria-label={`${selected ? "Clear rejection of" : "Reject"} ${imageTitle(i) || filename(i)}`}
        aria-pressed={selected}
        disabled={!favoriteStorage.ready}
        onClick={() => setSelection(i, selected ? "undecided" : "rejected")}
      >
        <svg viewBox="0 0 24 24" aria-hidden="true">
          <path d="m5 5 14 14 M19 5 5 19" />
        </svg>
      </button>
    );
  }
  const waxCircles = [
    [
      "M85 27 C74 6 26 5 12 29 C-2 51 8 80 36 88 C62 99 92 80 94 56 C96 36 91 25 83 19",
      "M84 24 C71 8 25 9 14 31 C0 56 13 82 37 90 C68 97 91 78 92 53 C94 32 88 24 80 17",
    ],
    [
      "M77 14 C51 2 20 13 10 38 C1 62 20 87 49 91 C77 94 93 74 91 48 C92 29 82 17 71 12",
      "M78 17 C50 6 22 14 13 40 C5 65 23 89 52 88 C77 90 95 70 88 45 C87 26 81 20 70 15",
    ],
    [
      "M92 40 C88 17 65 6 42 10 C17 13 5 32 7 56 C11 79 29 92 55 91 C77 89 94 76 94 52 C94 33 82 19 75 16",
      "M90 43 C86 19 62 10 40 12 C19 16 8 34 10 55 C12 80 32 89 56 88 C78 87 91 73 91 50 C93 32 81 22 72 17",
    ],
  ];
  const waxCrosses = [
    [
      "M10 12 Q31 29 50 51 T90 88 M88 11 Q68 32 49 53 T11 90",
      "M12 10 Q29 31 51 49 T89 90 M90 13 Q66 30 51 55 T9 88",
    ],
    [
      "M15 7 C29 28 57 58 85 93 M93 18 C69 35 40 59 8 82",
      "M12 9 C31 30 56 56 88 91 M92 15 C69 38 39 56 11 85",
    ],
    [
      "M7 19 Q47 49 93 82 M82 7 C64 35 34 68 18 92",
      "M9 16 Q46 52 90 85 M85 9 C61 35 37 68 15 89",
    ],
  ];
  function wax(i: number) {
    if (!waxOn || (!favorites.includes(i) && !rejected.includes(i)))
      return null;
    const no = rejected.includes(i),
      variant = i % 3,
      paths = (no ? waxCrosses : waxCircles)[variant];
    return (
      <svg
        className="waxmark"
        data-wax-variant={variant + 1}
        viewBox="0 0 100 100"
        preserveAspectRatio="none"
        aria-hidden="true"
        style={{ color: waxColor }}
      >
        <g
          fill="none"
          stroke="currentColor"
          strokeLinecap="round"
          strokeLinejoin="round"
        >
          <path
            opacity=".72"
            strokeWidth={variant === 1 ? "3.1" : variant === 2 ? "2.7" : "2.9"}
            d={paths[0]}
          />
          <path
            opacity=".3"
            strokeWidth="1.1"
            strokeDasharray={
              variant === 1
                ? "11 2 7 1"
                : variant === 2
                  ? "9 1 15 2"
                  : "13 1 6 2"
            }
            d={paths[1]}
          />
        </g>
      </svg>
    );
  }
  const [active, setActive] = useState<number | null>(null),
    [zoom, setZoom] = useState(false);
  const shareFiles = useRef<Record<string, File>>({});
  const [shareReady, setShareReady] = useState("");
  const [shareMessage, setShareMessage] = useState("");
  const [imageShareMessage, setImageShareMessage] = useState("");
  const initialImage = useRef(false);
  const dialog = useRef<HTMLDialogElement>(null);
  const opener = useRef<HTMLButtonElement | null>(null);
  function open(i: number, el?: HTMLButtonElement) {
    if (el) opener.current = el;
    setActive(i);
    setZoom(false);
    setImageShareMessage("");
  }
  function close() {
    dialog.current?.close();
    setActive(null);
    setZoom(false);
    opener.current?.focus();
  }
  function move(step: number) {
    setActive((i) => {
      if (i === null) return null;
      const list = visibleIndices.length
        ? visibleIndices
        : photos.map((_: any, n: number) => n);
      const at = list.indexOf(i);
      return list[(Math.max(at, 0) + step + list.length) % list.length];
    });
    setZoom(false);
    setImageShareMessage("");
  }
  useEffect(() => {
    if (active !== null && !dialog.current?.open) dialog.current?.showModal();
    if (active !== null) {
      const old = document.body.style.overflow;
      document.body.style.overflow = "hidden";
      return () => {
        document.body.style.overflow = old;
      };
    }
  }, [active]);
  useEffect(() => {
    if (!gallery || initialImage.current) return;
    initialImage.current = true;
    const id = new URLSearchParams(location.search).get("photo");
    const i = gallery.photos.findIndex((p: any) => p.id === id);
    if (i >= 0) open(i);
  }, [gallery]);
  useEffect(() => {
    if (active === null) {
      setShareReady("");
      return;
    }
    const src = photos[active];
    let live = true;
    if (shareFiles.current[src]) {
      setShareReady(src);
      return;
    }
    setShareReady("");
    fetch(src)
      .then((r) => {
        if (!r.ok) throw Error("Low-res image could not load.");
        return r.blob();
      })
      .then((blob) => {
        const base =
          filename(active)
            .replace(/\.[^.]+$/, "")
            .replace(/[^a-zA-Z0-9._-]/g, "_") || "photograph";
        const ext =
          blob.type === "image/png"
            ? "png"
            : blob.type === "image/webp"
              ? "webp"
              : "jpg";
        shareFiles.current[src] = new File([blob], base + "-proof." + ext, {
          type: blob.type || "image/jpeg",
        });
        if (live) setShareReady(src);
      })
      .catch(() => {
        if (live) {
          setShareReady(src);
          setImageShareMessage(
            "Low-res image could not load. Try reopening this image.",
          );
        }
      });
    return () => {
      live = false;
    };
  }, [active, gallery]);
  function saveProof(file: File) {
    const url = URL.createObjectURL(file);
    const a = document.createElement("a");
    a.href = url;
    a.download = file.name;
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 60000);
  }
  async function shareGallery(i?: number) {
    const image = typeof i === "number";
    const report = image ? setImageShareMessage : setShareMessage;
    report("");
    if (image) {
      const file = shareFiles.current[photos[i!]];
      if (!file) {
        report("Low-res image could not load. Try reopening this image.");
        return;
      }
      try {
        if (navigator.share && navigator.canShare?.({ files: [file] })) {
          await navigator.share({ files: [file] });
          return;
        }
        saveProof(file);
        report("Low-res image saved.");
      } catch (e: any) {
        if (e.name === "AbortError") return;
        saveProof(file);
        report("Sharing unavailable. Low-res image saved.");
      }
      return;
    }
    const url = new URL(location.href);
    url.search = "";
    url.hash = "";
    try {
      if (navigator.share) {
        await navigator.share({
          title: gallery?.title || "Sample gallery",
          url: url.href,
        });
        return;
      }
      await navigator.clipboard.writeText(url.href);
      report("Gallery link copied.");
    } catch (e: any) {
      if (e.name === "AbortError") return;
      try {
        await navigator.clipboard.writeText(url.href);
        report("Gallery link copied.");
      } catch {
        report("Copy this link: " + url.href);
      }
    }
  }
  function shareIcon() {
    return (
      <svg viewBox="0 0 24 24" aria-hidden="true">
        <path d="M12 16V3m-4 4 4-4 4 4M7 10H4v11h16V10h-3" />
      </svg>
    );
  }
  if (error && !gallery && galleryToken)
    return (
      <main
        className={`file-card ${gallery?.theme === "masonry" ? "theme-light theme-masonry" : (gallery?.theme || "dark") === "light" ? "theme-light" : "theme-dark"}`}
      >
        <p role="alert">{error}</p>
      </main>
    );
  if (galleryToken && !gallery)
    return (
      <main
        className={`file-card ${gallery?.theme === "masonry" ? "theme-light theme-masonry" : (gallery?.theme || "dark") === "light" ? "theme-light" : "theme-dark"}`}
      >
        <p>Loading photographs...</p>
      </main>
    );
  const canDownload = gallery ? gallery.downloads : downloads;
  const canWebDownload = gallery?.web_downloads === true && !canDownload;
  const photographer = gallery ? (gallery.photographer ?? "") : "";
  const website = gallery ? (gallery.website ?? "") : "";
  const safeWebsite = /^https?:\/\//i.test(website) ? website : "";
  const bareHeader = !!gallery && !photographer.trim() && !safeWebsite && !logo;
  return (
    <main
      className={`file-card ${gallery?.theme === "masonry" ? "theme-light theme-masonry" : (gallery?.theme || "dark") === "light" ? "theme-light" : "theme-dark"}`}
    >
      {(gallery?.brand_accent ||
        gallery?.header_color ||
        gallery?.header_font) && (
        <style>{`${gallery.header_color ? ".file-card .compactjob h1,.file-card .compactjob .photographer{color:" + gallery.header_color + "!important}" : ""}${gallery.brand_accent ? ".file-card .compactjob .clientinfo a,.file-card .compactjob .galleryshare{color:" + gallery.brand_accent + "!important}" : ""}${gallery.header_font ? ".file-card .compactjob h1{font-family:" + (gallery.header_font === "assistant" ? "Broach Assistant,sans-serif" : gallery.header_font === "serif" ? "Georgia,serif" : "Broach Archivo Black,sans-serif") + "!important}" : ""}`}</style>
      )}
      <section
        className={"jobdetails compactjob" + (bareHeader ? " bare" : "")}
      >
        {!bareHeader && (
          <div className="clientinfo">
            <h1>{gallery?.title || "Sample gallery"}</h1>
            <>
              {photographer.trim() && (
                <p className="photographer">
                  Photography by {photographer.trim()}
                </p>
              )}
            </>
            <>
              {safeWebsite && (
                <a href={safeWebsite} target="_blank" rel="noopener noreferrer">
                  {safeWebsite.replace(/^https?:\/\//i, "")}
                </a>
              )}
            </>
          </div>
        )}
        <div className="sheetactions">
          <button
            type="button"
            className="galleryshare"
            onClick={() => shareGallery()}
            aria-label="Share gallery"
            title="Share gallery"
          >
            {shareIcon()}
          </button>
          {shareMessage && (
            <small role="status" className="sharestatus">
              {shareMessage}
            </small>
          )}
          {(!gallery || logo) && (
            <div className="headermark">
              <img
                src={logo || eyeLogo}
                alt={logo ? "Gallery logo" : "Contact Sheet logo"}
              />
            </div>
          )}
          {canDownload &&
            (!gallery || gallery.photos.some((p: any) => p.has_original)) && (
              <>
                <button
                  className="downloadjob"
                  onClick={zipDownload}
                  disabled={!canDownload}
                >
                  Download all hi-res
                </button>
                <span>
                  {gallery ? "Original files · ZIP" : "Sample JPEGs · ZIP"}
                </span>
              </>
            )}
        </div>
      </section>
      <div className="selectionfilters">
        <label>
          Show{" "}
          <select
            aria-label="Filter photos by selection"
            value={selectionFilter}
            onChange={(e) => setSelectionFilter(e.target.value)}
          >
            <option value="all">All photos ({photos.length})</option>
            <option value="liked">Liked ({favorites.length})</option>
            <option value="rejected">Rejected ({rejected.length})</option>
            <option value="undecided">
              Undecided ({photos.length - favorites.length - rejected.length})
            </option>
          </select>
        </label>
      </div>
      <div className="tabletop">
        <section
          className="paper"
          aria-label={
            gallery?.theme === "masonry"
              ? "Photograph gallery"
              : "120 medium format contact sheet"
          }
        >
          <div className="negative">
            <div className="edge">
              120 <span>MEDIUM FORMAT</span> 01
            </div>
            <div className="frames">
              {visibleIndices.map((i) => (
                <div
                  key={photos[i]}
                  className={`frametile ${favorites.includes(i) ? "picked" : ""}`}
                >
                  <button
                    className="frame"
                    onClick={(e) => open(i, e.currentTarget)}
                    aria-label={`Open ${imageTitle(i)}`}
                  >
                    <span
                      className="frameimage"
                      style={{ position: "relative" }}
                    >
                      <ProofImage
                        src={photos[i]}
                        alt={imageTitle(i)}
                        loading={
                          visibleIndices.indexOf(i) < 6 ? "eager" : "lazy"
                        }
                        fetchPriority={
                          visibleIndices.indexOf(i) < 3 ? "high" : "auto"
                        }
                      />
                      {wax(i)}
                    </span>
                    <span className="framecode">
                      <span>{String(i + 1).padStart(2, "0")}</span>
                      <span>▵</span>
                      <span>120</span>
                    </span>
                  </button>
                  {heart(i)}
                  {reject(i)}
                  {gallery &&
                    (noteCounts[gallery.photos[i].id] ??
                      gallery.photos[i].comment_count ??
                      0) > 0 && (
                      <button
                        type="button"
                        onClick={(e) => open(i, e.currentTarget)}
                        aria-label={
                          "View notes on " + (imageTitle(i) || filename(i))
                        }
                        title="This image has notes"
                        className="gridnotes"
                        style={{
                          position: "absolute",
                          bottom: 0,
                          right: "calc(18% + 61px)",
                          width: 32,
                          height: 32,
                          padding: 8,
                          margin: 0,
                          border: 0,
                          background: "transparent",
                          color:
                            gallery.theme === "light" ||
                            gallery.theme === "masonry"
                              ? "#000"
                              : "#f3f3f3",
                          borderRadius: 0,
                        }}
                      >
                        <svg
                          viewBox="0 0 24 24"
                          aria-hidden="true"
                          style={{
                            width: 14,
                            height: 14,
                            fill: "none",
                            stroke: "currentColor",
                            strokeWidth: 2,
                          }}
                        >
                          <rect x="4" y="4" width="16" height="18" rx="2" />
                          <path d="M8 2v5m8-5v5M8 11h8m-8 4h8m-8 4h5" />
                        </svg>
                      </button>
                    )}
                </div>
              ))}
            </div>
            <div className="edge bottom">
              CONTACT PRINT <span>{photos.length} FRAMES</span> END
            </div>
          </div>
        </section>
      </div>
      <div className="selectionnote">
        <span>
          {favorites.length} liked · {rejected.length} rejected ·{" "}
          {photos.length - favorites.length - rejected.length} undecided
        </span>
        {!gallery && <small>Demo selections are not saved.</small>}
        <small role="status">{favoriteStorage.message}</small>
      </div>
      {!gallery && (
        <p className="testfoot">
          Demo · Sample images and downloads · No orders or payments
        </p>
      )}
      {error && <p role="alert">{error}</p>}
      <dialog
        ref={dialog}
        className="room"
        onCancel={(e) => {
          e.preventDefault();
          close();
        }}
        onKeyDown={(e) => {
          if (e.key === "ArrowRight") {
            e.preventDefault();
            move(1);
          }
          if (e.key === "ArrowLeft") {
            e.preventDefault();
            move(-1);
          }
        }}
      >
        {active !== null && (
          <>
            <header className="roomhead">
              <div className="roomtools">
                <button
                  type="button"
                  className="viewericon"
                  disabled={shareReady !== photos[active]}
                  onClick={() => shareGallery(active)}
                  aria-label="Share image"
                  title={
                    shareReady === photos[active]
                      ? "Share low-res image"
                      : "Preparing image"
                  }
                >
                  {shareIcon()}
                </button>
                {heart(active, true)}
                {reject(active, true)}
                <button
                  className="viewericon"
                  onClick={close}
                  aria-label="Close viewer"
                  title="Close"
                >
                  <svg viewBox="0 0 24 24" aria-hidden="true">
                    <path d="m6 6 12 12 M18 6 6 18" />
                  </svg>
                </button>
              </div>
            </header>
            <div className={`viewbody `}>
              <div className={`stage ${zoom ? "zoomed" : ""}`}>
                <button
                  className="prev"
                  onClick={() => move(-1)}
                  aria-label="Previous image"
                >
                  ‹
                </button>
                <PinchPhoto
                  key={active}
                  src={photos[active]}
                  alt={imageTitle(active)}
                  onDesktopClick={() => setZoom(!zoom)}
                  onSwipe={move}
                />
                <div className="imagecaption" aria-live="polite">
                  {imageShareMessage && (
                    <p role="status" className="sharestatus">
                      {imageShareMessage}
                    </p>
                  )}
                  {imageTitle(active)?.trim() && <h2>{imageTitle(active)}</h2>}
                  <p>
                    <span>Image name</span>
                    {filename(active)}
                  </p>
                  {canWebDownload && (
                    <div className="webdownload">
                      <a
                        onClick={(e) => saveWebCopy(e, active)}
                        href={`/api/galleries/${galleryToken}/media/${gallery.photos[active].id}/web`}
                        download={
                          /\.[^.]+$/.test(filename(active))
                            ? filename(active).replace(/(\.[^.]*)$/, "-web$1")
                            : filename(active) + "-web"
                        }
                      >
                        Save web size (for social) ↓
                      </a>
                      <small>
                        For screens and social media, not the original print
                        file.
                      </small>
                    </div>
                  )}
                  {canDownload &&
                    (!gallery || gallery.photos[active].has_original) && (
                      <a
                        className="downloadhires"
                        href={original(active)}
                        download={filename(active)}
                      >
                        Download hi-res (for print) ↓{" "}
                        {!gallery && <small>· Sample JPEG</small>}
                      </a>
                    )}
                  {gallery && (
                    <ImageNotes
                      key={gallery.photos[active].id}
                      token={galleryToken!}
                      photoId={gallery.photos[active].id}
                      onCount={(n) =>
                        setNoteCounts((old) => ({
                          ...old,
                          [gallery.photos[active].id]: n,
                        }))
                      }
                    />
                  )}
                </div>
                <button
                  className="next"
                  onClick={() => move(1)}
                  aria-label="Next image"
                >
                  ›
                </button>
              </div>
            </div>
            <div className="roomcaption">
              <span>
                {String(active + 1).padStart(2, "0")} / {photos.length}
              </span>
              <span>← → to browse · Esc to return</span>
            </div>
            <nav className="filmstrip" aria-label="Image thumbnails">
              {visibleIndices.map((i) => (
                <button
                  key={photos[i]}
                  className={`${i === active ? "selected" : ""} ${favorites.includes(i) ? "thumbpicked" : ""}`}
                  aria-label={`View frame ${i + 1}`}
                  aria-current={i === active ? "true" : undefined}
                  onClick={() => open(i)}
                >
                  <ProofImage src={photos[i]} alt="" loading="lazy" />
                  <span>{i + 1}</span>
                  {rejected.includes(i) && (
                    <b className="thumbheart rejectbadge" aria-label="Rejected">
                      ×
                    </b>
                  )}
                  {favorites.includes(i) && (
                    <b
                      className="thumbheart"
                      aria-label="Hearted"
                      style={{ fontFamily: "Arial,sans-serif" }}
                    >
                      ♥︎
                    </b>
                  )}
                </button>
              ))}
            </nav>
          </>
        )}
      </dialog>
    </main>
  );
}
