/** One user's presence on a note: how many tabs they have it open in. */
export interface PresenceEntry {
  userId: number;
  username: string;
  tabs: number;
}

/**
 * What the REST layer can ask of the live-sync layer. A narrow interface keeps app.ts independent of
 * the WebSocket code, and lets tests of REST routes run without any sockets.
 */
export interface RealtimeControl {
  /** Who has this note open right now. One entry per user, however many tabs. */
  presence(noteId: string): PresenceEntry[];
  /** Close every open tab of this user (they logged out). */
  disconnectUser(userId: number): void;
  /** Close this user's open notes from this team, leaving their other teams' notes alone (they were removed). */
  removeUserFromTeam(userId: number, teamId: number): void;
  /** Close every connection to this note (it was deleted). */
  closeNote(noteId: string): void;
}

export const noRealtime: RealtimeControl = {
  presence: () => [],
  disconnectUser: () => {},
  removeUserFromTeam: () => {},
  closeNote: () => {},
};
