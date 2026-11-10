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


