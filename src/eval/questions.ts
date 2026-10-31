export type QuestionKind = "keyword" | "paraphrase" | "typo" | "off-topic" | "near-miss";

export interface LabelledQuestion {
  question: string;
  kind: QuestionKind;
  /** Ids of the corpus documents that answer the question. Empty means the corpus cannot answer it. */
  relevant: readonly string[];
}

/**
 * Hand-written questions, written once against the corpus and not edited after seeing retrieval
 * results. `keyword` questions reuse the document's own words, `paraphrase` questions say the same
 * thing in different words, `typo` questions contain misspellings. `off-topic` and `near-miss`
 * questions have no answer in the corpus (near-misses share vocabulary with it).
 */
export const QUESTIONS: readonly LabelledQuestion[] = [
  // keyword
  { question: "How do I reset my password?", kind: "keyword", relevant: ["account-password"] },
  { question: "How long is the password reset link valid?", kind: "keyword", relevant: ["account-password"] },
  { question: "How do I turn on two-factor authentication?", kind: "keyword", relevant: ["two-factor"] },
  { question: "What do I do if I lose my phone with the authenticator app?", kind: "keyword", relevant: ["two-factor"] },
  { question: "How much does the Growth plan cost?", kind: "keyword", relevant: ["billing-plans"] },
  { question: "What is your refund policy?", kind: "keyword", relevant: ["billing-refunds"] },
  { question: "How many business days does a refund take?", kind: "keyword", relevant: ["billing-refunds"] },
  { question: "Where can I download my invoices as PDF?", kind: "keyword", relevant: ["billing-invoices"] },
  { question: "How do I change the VAT number on my invoices?", kind: "keyword", relevant: ["billing-invoices"] },
  { question: "Which payment methods do you accept?", kind: "keyword", relevant: ["billing-payment-methods"] },
  { question: "What happens when a payment fails?", kind: "keyword", relevant: ["billing-payment-methods"] },
  { question: "How do I cancel my subscription?", kind: "keyword", relevant: ["cancel"] },
  { question: "How do I invite a team member?", kind: "keyword", relevant: ["users-roles"] },
  { question: "Which banks can I connect for bank feeds?", kind: "keyword", relevant: ["integrations-bank"] },
  { question: "What is the maximum size of a CSV import?", kind: "keyword", relevant: ["import-export"] },
  { question: "How do I create an API token?", kind: "keyword", relevant: ["api"] },
  { question: "What is the API rate limit?", kind: "keyword", relevant: ["api"] },
  { question: "Where is my data hosted?", kind: "keyword", relevant: ["security-privacy"] },
  { question: "How do I request deletion of my data?", kind: "keyword", relevant: ["data-deletion"] },
  { question: "Does the mobile app work offline?", kind: "keyword", relevant: ["mobile-app"] },
  { question: "How do I contact support?", kind: "keyword", relevant: ["support-hours"] },
  { question: "How do I schedule reports by email?", kind: "keyword", relevant: ["reports"] },
  { question: "Is VAT calculated automatically for EU customers?", kind: "keyword", relevant: ["taxes"] },

  // paraphrase
  { question: "I can't get into my account any more", kind: "paraphrase", relevant: ["account-password"] },
  { question: "My login got blocked after I typed the wrong secret too many times", kind: "paraphrase", relevant: ["account-password"] },
  { question: "How can I add an extra layer of protection when logging in?", kind: "paraphrase", relevant: ["two-factor"] },
  { question: "What is the cheapest tier?", kind: "paraphrase", relevant: ["billing-plans"] },
  { question: "Can I get my money back?", kind: "paraphrase", relevant: ["billing-refunds"] },
  { question: "Is there a discount if I pay for the whole year?", kind: "paraphrase", relevant: ["billing-plans"] },
  { question: "I need a copy of what I paid for my accountant", kind: "paraphrase", relevant: ["billing-invoices"] },
  { question: "My credit card was declined, will I lose access?", kind: "paraphrase", relevant: ["billing-payment-methods"] },
  { question: "I want to stop being charged", kind: "paraphrase", relevant: ["cancel"] },
  { question: "How long do you keep my information after I leave?", kind: "paraphrase", relevant: ["cancel"] },
  { question: "Can I give a colleague access that only lets them look?", kind: "paraphrase", relevant: ["users-roles"] },
  { question: "Why did new transactions stop showing up from my bank?", kind: "paraphrase", relevant: ["integrations-bank"] },
  { question: "Can I move my existing spreadsheet into the product?", kind: "paraphrase", relevant: ["import-export"] },
  { question: "How can I connect my own scripts to the service?", kind: "paraphrase", relevant: ["api"] },
  { question: "Is the information I store protected from snooping?", kind: "paraphrase", relevant: ["security-privacy"] },
  { question: "I want everything about my company erased from your servers", kind: "paraphrase", relevant: ["data-deletion"] },
  { question: "Can I photograph paper receipts with my phone?", kind: "paraphrase", relevant: ["mobile-app"] },
  { question: "Can I speak to someone by telephone?", kind: "paraphrase", relevant: ["support-hours"] },
  { question: "Will I be compensated if your service goes down?", kind: "paraphrase", relevant: ["status-outages"] },
  { question: "Where do I see whether the service is having problems right now?", kind: "paraphrase", relevant: ["status-outages"] },

  // typo
  { question: "how do i reset my pasword", kind: "typo", relevant: ["account-password"] },
  { question: "authentcator app setup", kind: "typo", relevant: ["two-factor"] },
  { question: "refnd policy for anual plan", kind: "typo", relevant: ["billing-refunds"] },
  { question: "downlaod invoce pdf", kind: "typo", relevant: ["billing-invoices"] },
  { question: "cancle subscripton", kind: "typo", relevant: ["cancel"] },
  { question: "how do i invte a teammember", kind: "typo", relevant: ["users-roles"] },
  { question: "bank conection wont sync", kind: "typo", relevant: ["integrations-bank"] },
  { question: "api rate limt", kind: "typo", relevant: ["api"] },

  // off-topic
  { question: "What is the weather in Berlin today?", kind: "off-topic", relevant: [] },
  { question: "Can you recommend a good Italian restaurant?", kind: "off-topic", relevant: [] },
  { question: "What is the capital of France?", kind: "off-topic", relevant: [] },
  { question: "How do I train a neural network?", kind: "off-topic", relevant: [] },
  { question: "Translate this sentence into Spanish", kind: "off-topic", relevant: [] },
  { question: "Who won the football match last night?", kind: "off-topic", relevant: [] },

  // near-miss: on topic for the product, but the corpus does not say
  { question: "Can I send invoices in multiple currencies?", kind: "near-miss", relevant: [] },
  { question: "Do you have a Slack integration for notifications?", kind: "near-miss", relevant: [] },
  { question: "Does the product support payroll for employees?", kind: "near-miss", relevant: [] },
  { question: "Do you offer a lifetime license?", kind: "near-miss", relevant: [] },
  { question: "How do I change the language of the interface?", kind: "near-miss", relevant: [] },
  { question: "Can I recover an invoice I deleted by mistake?", kind: "near-miss", relevant: [] },
];
