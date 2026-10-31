/**
 * Fixture knowledge base for the evaluation and the demo: the help centre of "Ledgerly", a made-up
 * bookkeeping product. Everything here is invented; the domain name uses the reserved .example TLD.
 */
export interface CorpusDoc {
  id: string;
  title: string;
  content: string;
}

export const CORPUS: readonly CorpusDoc[] = [
  {
    id: "account-password",
    title: "Resetting your password",
    content: `# Resetting your password

## Forgot your password
On the sign-in page choose "Forgot password" and enter your email address. We send a reset link that is valid for 30 minutes. If the email does not arrive, check your spam folder and make sure you used the address on your account.

## Changing your password while signed in
Open Settings, then Security, then Change password. New passwords must have at least 12 characters and cannot repeat one of your last five passwords.

## Locked accounts
After 5 failed sign-in attempts an account is locked for 15 minutes. An Owner or Admin can unlock a team member immediately from Settings, then Team.`,
  },
  {
    id: "two-factor",
    title: "Two-factor authentication",
    content: `# Two-factor authentication

## Turning it on
Go to Settings, then Security, then Two-factor authentication. Scan the QR code with an authenticator app and enter the six-digit code to confirm. We do not support SMS codes.

## Recovery codes
When you enable two-factor authentication we show 10 single-use recovery codes. Store them somewhere safe. Each code works once if you cannot reach your authenticator app.

## Lost device
If you lose your phone and have no recovery codes, contact support. We verify your identity and reset two-factor authentication, which usually takes 2 business days.`,
  },
  {
    id: "billing-plans",
    title: "Plans and pricing",
    content: `# Plans and pricing

## Starter
Starter costs $12 per month. It includes up to 3 users and 100 invoices per month.

## Growth
Growth costs $39 per month. It includes up to 15 users, unlimited invoices and bank feeds.

## Enterprise
Enterprise pricing is custom. It adds single sign-on, a dedicated account manager and phone support.

## Annual billing
Paying annually gives you two months free compared with paying monthly. You can switch between monthly and annual billing under Billing, then Plan.`,
  },
  {
    id: "billing-refunds",
    title: "Refund policy",
    content: `# Refund policy

## Eligibility
Monthly plans can be refunded within 14 days of the first charge. Annual plans can be refunded within 30 days of purchase. We do not refund partial months or renewals.

## How refunds are paid
Refunds go back to the original payment method and take 5 to 10 business days to appear, depending on your bank.

## How to ask
Open a support request from Billing, then Help with a charge, and tell us the invoice number.`,
  },
  {
    id: "billing-invoices",
    title: "Invoices and receipts",
    content: `# Invoices and receipts

## Downloading invoices
Every charge produces an invoice. Download it as a PDF from Billing, then History. Receipts are also emailed to the billing contact after each payment.

## Billing address and VAT number
Update the billing address and VAT number under Billing, then Company details. Changes apply to future invoices only; past invoices cannot be edited.`,
  },
  {
    id: "billing-payment-methods",
    title: "Payment methods",
    content: `# Payment methods

## Accepted methods
We accept Visa, Mastercard and American Express cards. Customers in the EU can pay by SEPA direct debit and customers in the US by ACH transfer.

## Failed payments
If a payment fails we retry it 3 times over 7 days and email the billing contact each time. If every retry fails the workspace becomes read-only until a payment succeeds.

## Updating your card
Change your card under Billing, then Payment method. The new card is used for the next charge.`,
  },
  {
    id: "cancel",
    title: "Cancelling your subscription",
    content: `# Cancelling your subscription

## How to cancel
Owners can cancel under Billing, then Cancel plan. You keep full access until the end of the period you have already paid for, and you will not be charged again.

## What happens to your data
After cancelling we keep your data for 90 days so you can come back. After 90 days it is deleted permanently. You can reactivate your workspace at any time during those 90 days.`,
  },
  {
    id: "users-roles",
    title: "Team members and roles",
    content: `# Team members and roles

## Inviting people
Owners and Admins can invite people under Settings, then Team. Each invitation email is valid for 7 days.

## Roles
There are four roles. Owners manage billing and can delete the workspace. Admins manage settings and people. Members create and edit records. Viewers have read-only access and cannot change anything.

## Removing people
Removing a member frees their seat straight away. The last Owner cannot be removed.`,
  },
  {
    id: "integrations-bank",
    title: "Connecting bank accounts",
    content: `# Connecting bank accounts

## Supported banks
Bank feeds work with more than 12,000 banks in North America and Europe. Choose Settings, then Bank feeds, then Add account and sign in on your bank's own page. We never see your bank password.

## Sync schedule
Transactions sync every 6 hours. You can also press Sync now on the account page.

## Reconnecting
Many banks require you to re-authorise access every 90 days. When that happens the feed shows "Reconnect needed" and new transactions stop arriving until you sign in again.`,
  },
  {
    id: "import-export",
    title: "Importing and exporting data",
    content: `# Importing and exporting data

## Importing
Import contacts, invoices or transactions from CSV files under Settings, then Import. Files can be up to 10 MB or 50,000 rows. The importer shows a preview and lists rows it could not read before anything is saved.

## Exporting
Export everything as CSV or JSON under Settings, then Data. Large exports can take up to 10 minutes. We email a download link that expires after 24 hours.`,
  },
  {
    id: "api",
    title: "API access",
    content: `# API access

## Tokens
Create API tokens under Settings, then Developer. A token is shown once when you create it; store it securely. Revoke a token at any time from the same page.

## Rate limits
The API allows 100 requests per minute per token. Requests over the limit receive HTTP 429 with a Retry-After header.

## Webhooks
Webhooks retry up to 5 times with exponential backoff. Every delivery carries a signature header you should verify before trusting the payload.`,
  },
  {
    id: "security-privacy",
    title: "Security and data protection",
    content: `# Security and data protection

## Encryption
Data is encrypted in transit with TLS 1.2 or newer and at rest with AES-256.

## Where data lives
You choose a hosting region when you create the workspace: Frankfurt for the EU or Virginia for the US. The region cannot be changed later. We do not currently hold a SOC 2 report.

## Access by our staff
Support staff can only open your workspace with a time-limited grant that you approve from Settings, then Privacy.`,
  },
  {
    id: "data-deletion",
    title: "Deleting your data",
    content: `# Deleting your data

## Requesting deletion
Owners can request deletion of all workspace data under Settings, then Privacy, then Delete workspace. Export your data first because deletion cannot be undone.

## Timelines
We process deletion requests within 30 days. Backups are purged within a further 35 days. Legal records such as invoices we issued to you are kept for the period tax law requires.`,
  },
  {
    id: "mobile-app",
    title: "Mobile app",
    content: `# Mobile app

## Requirements
The app runs on iOS 16 or newer and Android 10 or newer.

## Receipt scanning
Use the camera button to photograph a paper receipt. The app reads the date, total and supplier and attaches the image to the transaction.

## Offline mode
Without a connection the app stores up to 50 receipts and uploads them automatically when you are back online.`,
  },
  {
    id: "taxes",
    title: "Sales tax and VAT",
    content: `# Sales tax and VAT

## Automatic VAT
VAT rates for all EU countries are applied automatically based on the customer's country. Admins can edit rates under Settings, then Taxes.

## Reports
The tax summary report groups tax collected and paid by quarter and exports to CSV. Ledgerly does not file tax returns on your behalf.`,
  },
  {
    id: "support-hours",
    title: "Contacting support",
    content: `# Contacting support

## Channels
Email help@ledgerly.example or use the chat in the app. Chat is staffed on weekdays from 09:00 to 17:00 CET. We answer email within 1 business day.

## Priority support
Growth customers get a first response within 4 hours on business days. Enterprise customers can also call +49 30 5550 0142 during chat hours.`,
  },
  {
    id: "status-outages",
    title: "Service status and outages",
    content: `# Service status and outages

## Status page
Live status and past incidents are published on status.ledgerly.example. During an incident we post an update at least every 30 minutes.

## Service credits
If monthly uptime falls below 99.5 percent, Growth and Enterprise customers can request a credit of 10 percent of that month's fee within 30 days of the incident.`,
  },
  {
    id: "reports",
    title: "Reports",
    content: `# Reports

## Standard reports
Ledgerly includes profit and loss, balance sheet and cash flow reports. Each can use a custom date range and be compared with the previous period.

## Scheduled reports
Schedule any report to be emailed weekly or monthly under Reports, then Schedule. Recipients do not need a Ledgerly account. Reports can be saved as PDF or CSV.`,
  },
];
