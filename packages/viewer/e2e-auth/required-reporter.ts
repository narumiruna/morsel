import type {
  FullResult,
  Reporter,
  Suite,
  TestCase,
  TestResult,
  TestStep,
} from "@playwright/test/reporter"

const required = new Set([
  "required real-backend account and API key lifecycle",
  "required real-backend OAuth discovery, registration, and PKCE",
  "required real-backend OAuth passkey consent, continuation, and no GET issuance",
  "required real-backend OAuth exchange, expiry, refresh rotation, and replay",
  "required real-backend OAuth denial, errors, and displayed-account binding",
  "required real-backend OAuth account switch, session replacement, and cross-tab logout",
  "required real-backend OAuth delayed consent and connected-app response races",
  "required real-backend OAuth account-owned connected-app revocation",
  "required real-backend OAuth recovery, credential separation, and legacy keys",
])

/** Print only fixed progress. Worker output and assertion values can contain credentials. */
export default class RequiredReporter implements Reporter {
  private total = 0
  private completed = 0
  private passed = 0
  private skipped = 0
  private steps = 0
  private failed = false

  onBegin(_config: unknown, suite: Suite) {
    const tests = suite.allTests()
    const names = new Set(tests.map((test) => test.title))
    this.total = tests.length
    this.failed =
      this.total !== required.size ||
      names.size !== required.size ||
      [...required].some((name) => !names.has(name))
    console.log(`Authentication browser tests: ${required.size} required`)
    if (this.failed)
      console.error("Required authentication browser cases are missing or duplicated")
  }

  onTestEnd(test: TestCase, result: TestResult) {
    this.completed += 1
    const passed =
      required.has(test.title) && result.status === "passed" && test.expectedStatus === "passed"
    if (passed) this.passed += 1
    else this.failed = true
    if (result.status === "skipped") this.skipped += 1
    console.log(
      `Authentication browser case ${this.completed}/${this.total}: ${passed ? "passed" : "failed"}`,
    )
  }

  onStepEnd(_test: TestCase, _result: TestResult, step: TestStep) {
    if (step.category !== "test.step") return
    this.steps += 1
    console.log(`Authentication browser check ${this.steps}: ${step.error ? "failed" : "passed"}`)
  }

  onStdOut() {
    // Never forward worker output, including console messages and subprocess payloads.
  }

  onStdErr() {
    // Browser and worker diagnostics can also contain callback URLs or credentials.
  }

  onError() {
    this.failed = true
    console.error("Authentication browser runner error (credential details suppressed)")
  }

  async onEnd(result: FullResult): Promise<{ status: "passed" | "failed" }> {
    const ok =
      result.status === "passed" &&
      !this.failed &&
      this.total === required.size &&
      this.passed === this.total &&
      this.skipped === 0
    console.log(
      `Authentication browser tests: ${this.passed}/${this.total} passed; ${this.skipped} skipped`,
    )
    return { status: ok ? "passed" : "failed" }
  }
}
