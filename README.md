# Bluestaq

Team note-taking service. TypeScript backend (Express, Postgres) and frontend (React, Tailwind).

## Notes

I pictured a Google-Doc type product. 
Each user can be a member of multiple teams.
Each team has a collection of notes.
Each note can be viewed and edited by everyone on the team.
As a note is edited, each users view of that note needs to update (just like Google Docs) - use sockets.
Anyone on a team can delete any of the notes.
A user can open the same note multiple times.
No "read-only" role.
No "user-only" notes. (Notes are per-team)
What about deployment and sockets and notes being edited? -- Edits stay local on the browser. When the server restarts and the browsers reconnect, each browser sends its notes updates. The note is updated. All views are updated.
The note "Title" is not part of the live update. I would change this, so it acts just like the note body (as users alter the title, other users see those changes live).
It would be nice to be able to share a note with other users or other teams. I did not implement this.
It would be nice to have rich text editing. I did not implement this.
It might be nice to allow comments. So, users can add comments to a specific section of the note (like Google Docs).
Searching for old notes would be nice.


