# AM/NS Pune Coil Tracking System — Internal Server Package

## What is included
- Web UI using the supplied AM/NS red/white/dark visual direction.
- Node.js + SQLite backend. Coil inventory, saddle positions, transfer requests, user accounts and movement history persist in `data/amns-coils.sqlite`.
- Individual username/password authentication with bcrypt password hashes and server-side sessions.
- Admin UI for creating/deactivating accounts.
- Crane scopes `CRANE 1` through `CRANE 25`, department-scoped accounts, inventory Excel export (`.xlsx`) and movement history.
- No preloaded sample coil numbers or occupied yard cells.

## Important scope / limitations
- This is an implementation starter and needs a controlled test on an AM/NS-approved server before operational use.
- The current UI uses the same main concepts and styling as the supplied HTML but is a connected implementation of those concepts, not a byte-for-byte patch of the original file.
- Camera tracking is intentionally not enabled: no camera has been installed. Camera feed access, image recognition, PLC/position integration and physical location verification are not implemented.
- This version provides a basic grid and manual coil location updates; it does not verify actual crane movement or prevent every possible unsafe stacking configuration. Validate physical stacking and movement rules with operations before production use.
- Department and crane scope enforcement is a starter permission model. AM/NS IT/security should review and approve the precise permissions matrix before deployment.
- SQLite is appropriate for a modest single-server internal deployment. For larger multi-user/HA deployments, have IT host PostgreSQL and adapt the data layer.
- HTTPS/reverse proxy, network access controls, backups, retention, monitoring, password reset procedures and security testing must be configured by company IT before production.
- User accounts must be created by an administrator. Do not use shared/demo passwords.

## Requirements
- Node.js 20 or newer.
- Build tools may be needed to install `better-sqlite3` on the target server.
- An AM/NS-approved internal server or VM with persistent disk storage.

## Setup (Windows PowerShell)
1. Copy this folder to an approved internal server.
2. Install Node.js 20+.
3. Copy `.env.example` to `.env`; replace `SESSION_SECRET` with a long random value and set a unique initial admin password.
4. Install dependencies:
   ```powershell
   npm install
   ```
5. Start the application:
   ```powershell
   npm start
   ```
6. Browse from an authorized network to `http://SERVER-HOSTNAME:3000`. Ask IT to provide HTTPS and an approved hostname before production.
7. After the first admin is created, remove `INITIAL_ADMIN_PASSWORD` from `.env` or change it to a non-secret placeholder. The account is created only if there is no admin account yet.
8. Create user accounts in the Admin panel. Use strong individual passwords of at least 12 characters.
9. Back up the entire `data` directory regularly while the application is stopped or using a SQLite-safe backup method.

## Account roles
- `ADMIN`: user administration, all scopes.
- `CRANE`: crane workflow. Assign scope `CRANE 1` to `CRANE 25`.
- `DEPARTMENT`: scope limited to a configured department/area.
The department list is in `server.js` and can be reviewed with operations. Current requested list includes CRM 1, CRM 3, CRS, TRM 1, TRM 2, CGL 1, CGL 2, FSL, CCL and CNRNTY, plus exit-line labels used by the UI.

## Create account via command line (optional)
```bash
npm run create-user -- crane01 "Use-a-unique-long-password" CRANE "CRANE 1"
npm run create-user -- cgl1user "Use-another-long-password" DEPARTMENT "CGL 1"
```
The server must be stopped before creating users through this command if it is running, to avoid database write contention. Prefer the Admin UI for normal account creation.

## Excel export
Sign in, then click **Download Excel**. The workbook contains `Current Inventory` and `Movement History` worksheets. It exports actual stored data; no fake inventory is inserted.

## Internal deployment checklist
- [ ] AM/NS IT approves host, ports, data storage and camera/network plan.
- [ ] Change secrets; configure HTTPS and trusted reverse proxy.
- [ ] Create named accounts for each authorized user; verify each role's allowed actions.
- [ ] Test duplicate coil registration, location changes, saddle moves, transfer completion and confirmation.
- [ ] Test Excel export and restore from backup.
- [ ] Confirm operational stacking rules and crane workflows with line owners.
- [ ] Add camera only after the camera model, network path and integration approach are approved.
