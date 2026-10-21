import type {
  FullResult,
  Reporter,
  Suite,
  TestCase,
  TestResult,
  TestStep,
} from "@playwright/test/reporter"

/** Do not print request bodies, assertion values, or attachments containing credentials. */
export default class RequiredReporter implements Reporter {
  private total = 0
  private passed = 0
  private failed = false

  onBegin(_config: unknown, suite: Suite) {
    this.total = suite.allTests().length
    console.log(`Authentication browser tests: ${this.total} required`)
  }

  onTestEnd(test: TestCase, result: TestResult) {
    if (result.status === "passed" && test.expectedStatus === "passed") this.passed += 1
    else this.failed = true
    console.log(`${result.status}: ${test.title}`)
    // Locations are safe to print; Playwright error messages can contain raw API keys.
    for (const error of result.errors) {
      if (error.location) console.error(`${error.location.file}:${error.location.line}`)
    }
  }

  onStepEnd(_test: TestCase, _result: TestResult, step: TestStep) {
    if (step.category === "test.step")
      console.log(`${step.error ? "failed" : "passed"} step: ${step.title}`)
  }

  onStdOut(chunk: string | Buffer) {
    process.stdout.write(chunk)
  }

  onError() {
    this.failed = true
    console.error("Authentication browser runner error (credential details suppressed)")
  }

  async onEnd(result: FullResult): Promise<{ status: "passed" | "failed" }> {
    const ok =
      result.status === "passed" && !this.failed && this.total > 0 && this.passed === this.total
    console.log(`Authentication browser tests: ${this.passed}/${this.total} passed`)
    return { status: ok ? "passed" : "failed" }
  }
}
