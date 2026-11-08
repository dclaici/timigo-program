# timigo-program

Programul cultural al Timișoarei — spectacole, concerte și reprezentații — pentru aplicația **timiGO**.

`events.json` se actualizează automat în fiecare noapte din site-urile oficiale ale instituțiilor
(Opera Națională Română, Teatrul Național „Mihai Eminescu”, Teatrul German de Stat, Teatrul Maghiar
„Csiky Gergely”, Teatrul Merlin, Filarmonica Banatul). Fiecare eveniment trimite la pagina instituției
și la biletele ei; drepturile asupra conținutului aparțin instituțiilor.

Scriptul: `scripts/build-events.ts` (respectă robots.txt; o cerere pe pagină, o dată pe zi).
