import { useEffect, useState, useRef } from "react";
export function useLocalState(
  gallery: any,
  token: string | null,
): [number[], (next: number[]) => void, { ready: boolean; message: string }] {
  const [favorites, setFavorites] = useState<number[]>([]),
    [message, setMessage] = useState(""),
    [busy, setBusy] = useState(false);
  const current = useRef<number[]>([]);
  useEffect(() => {
    if (gallery) {
      const picks = gallery.photos
        .map((p: any, i: number) => (p.hearted ? i : -1))
        .filter((i: number) => i >= 0);
      setFavorites(picks);
      current.current = picks;
      setMessage("Selections loaded.");
    }
  }, [gallery]);
  async function save(next: number[]) {
    if (busy) return;
    const old = current.current;
    const changed = [...new Set([...old, ...next])].filter(
      (i) => old.includes(i) !== next.includes(i),
    );
    setBusy(true);
    setMessage("Saving...");
    try {
      if (token) {
        for (const i of changed) {
          const r = await fetch(`/api/galleries/${token}/picks`, {
            method: "PUT",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              photoId: gallery.photos[i].id,
              hearted: next.includes(i),
            }),
          });
          if (!r.ok) throw Error("Selection was not saved. Please retry.");
        }
      }
      current.current = next;
      setFavorites(next);
      setMessage(
        token ? "Saved to your photographer." : "Demo selection only.",
      );
    } catch (e: any) {
      setMessage(e.message);
    } finally {
      setBusy(false);
    }
  }
  return [favorites, save, { ready: !busy && (!token || !!gallery), message }];
}

export function useSelections(
  gallery: any,
  token: string | null,
): [
  number[],
  (i: number, state: "liked" | "rejected" | "undecided") => void,
  { ready: boolean; message: string },
  number[],
] {
  const [favorites, setFavorites] = useState<number[]>([]),
    [rejected, setRejected] = useState<number[]>([]),
    [message, setMessage] = useState(""),
    [busy, setBusy] = useState(false);
  const saving = useRef(false);
  useEffect(() => {
    if (gallery) {
      setFavorites(
        gallery.photos
          .map((p: any, i: number) => (p.hearted && !p.rejected ? i : -1))
          .filter((i: number) => i >= 0),
      );
      setRejected(
        gallery.photos
          .map((p: any, i: number) => (p.rejected ? i : -1))
          .filter((i: number) => i >= 0),
      );
      setMessage("Selections loaded.");
    }
  }, [gallery]);
  async function save(i: number, state: "liked" | "rejected" | "undecided") {
    if (saving.current) return;
    saving.current = true;
    setBusy(true);
    setMessage("Saving...");
    try {
      if (token) {
        const r = await fetch(`/api/galleries/${token}/picks`, {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            photoId: gallery.photos[i].id,
            selection: state,
          }),
        });
        if (!r.ok) throw Error("Selection was not saved. Please retry.");
      }
      setFavorites((old) =>
        state === "liked"
          ? [...old.filter((n) => n !== i), i]
          : old.filter((n) => n !== i),
      );
      setRejected((old) =>
        state === "rejected"
          ? [...old.filter((n) => n !== i), i]
          : old.filter((n) => n !== i),
      );
      setMessage(
        token ? "Saved to your photographer." : "Demo selection only.",
      );
    } catch (e: any) {
      setMessage(e.message);
    } finally {
      saving.current = false;
      setBusy(false);
    }
  }
  return [
    favorites,
    save,
    { ready: !busy && (!token || !!gallery), message },
    rejected,
  ];
}
