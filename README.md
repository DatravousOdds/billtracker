# Bill Split

A bill tracker for two partners. It splits shared bills by each partner's share of combined income and syncs live between both phones through Supabase.

**Stack:** Vite + React + TypeScript · plain CSS · Supabase (Postgres, Auth, Realtime)

## What it does

- **This week:** each partner's amount for the week, bills due, overdue bills, and approvals waiting for you.
- **Payment reminders:** any bill that's due today or overdue shows up at the top of This week with a *Confirm paid* button, and counts toward the badge on the tab. The app never moves money; it only records what you confirm (autopay bills are skipped).
- **Smoothed weekly amounts (default):** shared monthly bills × 12 ÷ 52 every week, plus any one-time bills due that week. Each partner deposits their income share into a shared bill account. You can switch to *pay as due* in Settings.
- **Income:** fixed by default, using the usual paycheck × paychecks per year ÷ 12. Each partner can switch to *log each paycheck*, and then chooses how the average is calculated: *Automatic* adds up their latest month's worth of paychecks, *By paycheck* takes the average of those paychecks × paychecks per year ÷ 12. A month's worth depends on how often they're paid: weekly 4, every 2 weeks 2, twice a month 2, monthly 1. Until that many are logged, the usual paycheck is used.
- **Left after bills:** on This week, each partner sees what's left of their income this week and this month after their share of shared bills and their own personal bills.
- **Custom split:** instead of splitting by income, either partner can propose their own percentage on the Income tab. It applies once the other partner approves, and going back to the income split needs approval too. A partner leaving resets it.
- **Personal bills:** all bills start shared. Either partner can request to make a bill personal (or shared again), and the other partner must approve. The database enforces this, so it can't be skipped.
- **Both phones can edit everything except income:** each partner changes only their own pay and paychecks (the partner's are view-only). Changes appear on the other phone right away.
- **History:** payments, deposits, a running balance (who has covered more than their share), and an activity log of who changed what.

## Try the demo (no setup)

```bash
npm install
npm run build:demo        # → dist-demo/index.html, open it in a browser
```

The demo uses sample data in memory. Use the purple bar to switch between Alex's and Sam's phones.

## Set up for real

1. **Create a Supabase project** (the free tier is fine) at https://supabase.com.
2. **Create the database:** in the Supabase dashboard, open **SQL Editor → New query**, paste the whole contents of `supabase/schema.sql`, and click **Run**. Then run `supabase/paycheck-average.sql`, `supabase/own-income.sql` and `supabase/custom-split.sql` the same way (all safe to re-run; existing projects need them too).
3. **Auth settings:**
   - **Send email through Resend.** Supabase's built-in email only reaches your own team's addresses and allows just a few emails an hour, so your partner's confirmation email may never arrive. In [Resend](https://resend.com), verify a domain you own (**Domains → Add domain**) and create an API key. Then in Supabase go to **Authentication → Emails → SMTP Settings**, turn on custom SMTP, and enter: host `smtp.resend.com`, port `465`, username `resend`, password = your Resend API key, and a sender address on your verified domain (e.g. `bills@yourdomain.com`).
   - **Redirect URLs.** Under **Authentication → URL Configuration**, set **Site URL** to where the app runs (for now `http://localhost:5173`) and add it, plus any deployed URL, to **Redirect URLs**. The confirmation link sends people back there.
   - Email sign-up and "Confirm email" are on by default. Signing in before confirming sends a fresh link.
4. **Add your keys:** copy `.env.example` to `.env` and fill in the values from **Project Settings → API** (Project URL and the `anon` public key).
5. **Run it:**
   ```bash
   npm install
   npm run dev          # opens on your network, so you can test from your phone on the same Wi-Fi
   ```
6. **Get both of you in:** one partner creates an account and chooses **Start a household**. The other creates an account, chooses **Join**, and enters the 6-letter invite code shown in Settings.
7. **Leaving:** run `supabase/leave.sql` once in **SQL Editor** (after `schema.sql`; safe to re-run). Then either partner can tap **Leave household** in Settings to stop splitting bills. The household gets a new invite code, so they can't rejoin unless the remaining partner shares it.

## Admin and support (app owner)

An in-app admin screen at `#/admin` (linked from Settings) shows every household and user.

| Role | Can do |
|---|---|
| **Admin** | Everything: look up users, edit or delete any bill, payment, deposit or paycheck, remove members, delete accounts or households, reset invite codes, and change roles in **Settings → Account roles** |
| **Support** | View every household and user, reset invite codes. No edits or deletes |
| **User** | Default. Only their own household |

1. In **SQL Editor**, run `supabase/admin.sql` once (after `schema.sql` and `leave.sql`; safe to re-run).
2. Make yourself the first admin:
   ```sql
   insert into public.app_roles (user_id, role) select id, 'admin' from auth.users where email = 'you@example.com';
   ```
3. Sign out and back in. From then on, give other accounts roles in **Settings → Account roles**. Nobody can change their own role, so the last admin can't lock themselves out.

Access is enforced in the database (`is_admin()` / `is_staff()`), so the role only matters on the server; opening `#/admin` without one shows nothing.

## Deploy so it works anywhere

`npm run build` creates a static site in `dist/`. Host it on Netlify, Vercel, Cloudflare Pages, or GitHub Pages, and set the two `VITE_SUPABASE_*` environment variables in the host's settings. Then, in Supabase, go to **Authentication → URL Configuration** and add your site URL.

On each phone, open the site and choose **Add to Home Screen** so it opens like an app.

## iPhone app (Capacitor)

The same code runs as a native iPhone app. The `ios/` folder is the Xcode project.

After changing the code, run `npm run ios`. It builds the app, copies it into `ios/`, and opens Xcode.

**First time in Xcode:** select the **App** target → **Signing & Capabilities** → choose your Team (needs an Apple Developer account for TestFlight). Bundle ID is `com.datravousodds.billsplit`.

**Ship to TestFlight:**
1. In App Store Connect (appstoreconnect.apple.com), **Apps → + → New App**, platform iOS, bundle ID `com.datravousodds.billsplit`.
2. In Xcode, set the run destination to **Any iOS Device (arm64)**, then **Product → Archive**.
3. In the Organizer window that opens: **Distribute App → TestFlight & App Store → Distribute**.
4. In App Store Connect → your app → **TestFlight**, add both of you as internal testers. Install the **TestFlight** app on each iPhone and accept the invite.

Each upload needs a higher **Build** number (App target → General → Identity).

## Project layout

```
supabase/schema.sql      tables, row-level security, approval + invite functions, activity-log triggers, realtime
supabase/leave.sql       leave_household(): a partner leaves (last one out deletes the household)
supabase/admin.sql       admin/support roles: app_roles table, staff RLS policies, admin functions
supabase/paycheck-average.sql  members.paycheck_average: Automatic vs By paycheck for logged income
supabase/own-income.sql        each partner edits only their own income and paychecks (both can view)
supabase/custom-split.sql      propose_split()/decide_split(): a custom % split both partners approve
src/logic/               pure functions (unit-tested): money, dates, recurrence, income, split, ledger
src/store.ts             loads household data, realtime sync, all reads/writes (+ demo-mode versions)
src/App.tsx              sign-in routing, app shell and tab navigation
src/views/               one React component file per screen
src/ui/                  shared components (Sheet, AsyncButton, bill rows), hooks and toast
src/demo.ts              sample data for the demo build
tests/logic.test.ts      npm test
tests/admin.test.ts      runs the SQL files in an in-memory Postgres (PGlite) and checks who can read/change what
```

## How the numbers work

| Thing | Rule |
|---|---|
| Monthly income (fixed) | paycheck × (52 weekly, 26 biweekly, 24 twice-a-month, 12 monthly) ÷ 12 |
| Monthly income (logged) | latest month's worth of paychecks (weekly 4, biweekly 2, twice-a-month 2, monthly 1). Automatic: their sum. By paycheck: their average × paychecks per year ÷ 12. Falls back to the usual paycheck until that many are logged |
| Income share | your monthly income ÷ combined monthly income (50/50 if neither has income entered) |
| Bill per month | weekly × 52/12 · biweekly × 26/12 · monthly × 1 · quarterly ÷ 3 · yearly ÷ 12 · one-time counts only in the week it's due |
| Smoothed weekly | shared bills per month × 12 ÷ 52 + one-time shared bills due this week |
| Left after bills | income − your split of shared bills due − your personal bills due, for this Sun–Sat week and this calendar month. Bills count paid or not; a paid bill counts at the amount paid. Month uses monthly income (an average month, not actual paydays); week uses monthly × 12 ÷ 52, or for *Automatic* the average logged paycheck × paychecks per year ÷ 52 |
| Running balance | (deposits + shared bills you paid directly) − your income share of everything both of you put in. The two balances always add up to $0. |

Money is stored as whole cents, so totals never drift. Splits are rounded so the two parts always add up exactly to the total.

## Security notes

- Row-level security limits every query to your own household. The only exception is accounts the app owner gives a staff role (`supabase/admin.sql`): **support** can read every household, and **admin** can read and change every household.
- A household is capped at two partners.
- Deposits are per person: you can only record or remove your own. Your partner's deposits are visible but read-only. Admins can correct any deposit.
- Who pays a bill can only change through `decide_request()`, called by the partner who *didn't* make the request, or by an admin.
- The invite code and household ID can't be edited from the app.
