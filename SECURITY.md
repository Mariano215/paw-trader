# Security Policy

## Reporting a vulnerability

If you think you've found a security issue in Paw Trader, please do not open a public GitHub issue. Instead, email **mariano@matteisystems.com** with:

- A description of the issue
- Steps to reproduce
- The affected file or component
- Any proof-of-concept code
- Your name or handle if you'd like credit in the fix notes

You will get an acknowledgment within 72 hours. Fix timeline depends on severity; critical issues are prioritized.

## Scope

**In scope**
- Credential or token leakage in code or logs
- Authentication or authorization bypass in the trader API routes
- Injection vulnerabilities (SQL, command, prompt injection into committee agents)
- Unsafe order placement paths that could bypass kill switches or autonomy gates
- Remote code execution via agent inputs

**Out of scope**
- Trading losses, strategy performance, or model behavior
- Denial of service against a Claude or Anthropic API quota
- Issues in upstream dependencies (report those upstream)
- Social engineering or phishing against ClaudePaw operators

## Responsible disclosure

Please give us a reasonable time window to fix the issue before public disclosure. A standard 90-day window works for most cases; sooner if the fix is simple, longer if the fix requires coordination with brokers or upstream engines.
