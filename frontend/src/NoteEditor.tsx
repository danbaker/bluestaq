import { useEffect, useRef, useState } from "react";
import { EditorContent, useEditor } from "@tiptap/react";
import Document from "@tiptap/extension-document";
import Paragraph from "@tiptap/extension-paragraph";
import Text from "@tiptap/extension-text";
import Collaboration from "@tiptap/extension-collaboration";
import { HocuspocusProvider } from "@hocuspocus/provider";
import * as Y from "yjs";
import { api, ApiError } from "./api";

type Status = "connecting" | "connected" | "offline";

const STATUS_TEXT: Record<Status, string> = {
  connecting: "Connecting…",
  connected: "Live: edits sync instantly",
  offline: "Offline: your edits are kept and will sync when you reconnect",
};

function socketUrl() {
  return `${window.location.protocol === "https:" ? "wss" : "ws"}://${window.location.host}/ws`;
}

interface Props {
  noteId: string;
  /** The note was deleted, or the user lost access to it. */
  onAccessLost: () => void;
  /** The login ended (for example, logged out in another tab). */
  onSessionEnded: () => void;
}

/**
 * The live note body. Every tab that opens the same note joins one shared document, so edits
 * appear everywhere as they are typed. The server decides who may open which note.
 */
export default function NoteEditor({ noteId, onAccessLost, onSessionEnded }: Props) {
  const [status, setStatus] = useState<Status>("connecting");
  const [collab, setCollab] = useState<{ doc: Y.Doc } | null>(null);
  // The connection outlives renders, so it reads the latest callbacks from here instead of capturing old ones.
  const callbacks = useRef({ onAccessLost, onSessionEnded });
  useEffect(() => {
    callbacks.current = { onAccessLost, onSessionEnded };
  });

  useEffect(() => {
    let cancelled = false; // set when we leave this note: a late answer must not affect whatever is shown next
    let probing = false;
    const doc = new Y.Doc();
    const provider = new HocuspocusProvider({
      url: socketUrl(),
      name: noteId,
      document: doc,
      token: "session-cookie", // the server identifies us by the login cookie; the library just needs a value
      onStatus: ({ status }) => setStatus(status === "connected" ? "connected" : status === "connecting" ? "connecting" : "offline"),
      onAuthenticationFailed: () => callbacks.current.onAccessLost(),
      onClose: () => {
        // The server closed this note, or the socket dropped. A dropped socket reconnects by itself, but a note the
        // server closed (deleted, removed from the team) just stays closed, so ask the server what happened:
        // 401 = our login ended, 404 = the note is gone or we no longer have access, anything else = a blip.
        // At most one check at a time, so a flaky connection that keeps failing to reconnect doesn't flood the server.
        if (probing) return;
        probing = true;
        api
          .note(noteId)
          .catch((err) => {
            if (cancelled || !(err instanceof ApiError)) return;
            if (err.status === 401) callbacks.current.onSessionEnded();
            else if (err.status === 404) callbacks.current.onAccessLost();
          })
          .finally(() => {
            probing = false;
          });
      },
    });
    setCollab({ doc });
    return () => {
      cancelled = true;
      provider.destroy();
      doc.destroy();
      setCollab(null);
    };
  }, [noteId]);

  return (
    <div>
      <p
        className={`mb-3 text-xs ${status === "connected" ? "text-emerald-400" : status === "offline" ? "text-amber-400" : "text-slate-400"}`}
        role="status"
      >
        {STATUS_TEXT[status]}
      </p>
      {collab && <EditorSurface doc={collab.doc} />}
    </div>
  );
}

function EditorSurface({ doc }: { doc: Y.Doc }) {
  const editor = useEditor(
    {
      // Plain paragraphs only for now. The shared field is Tiptap's default ("default"), which is what the
      // server reads to build previews, so formatting can be added later just by adding extensions here.
      extensions: [Document, Paragraph, Text, Collaboration.configure({ document: doc })],
      editorProps: {
        attributes: {
          "aria-label": "Note body",
          class: "rounded-lg bg-slate-800 p-4 text-slate-100",
        },
      },
    },
    [doc],
  );
  return <EditorContent editor={editor} />;
}
