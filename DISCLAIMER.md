# Disclaimer

Paw Trader is an open-source research and educational project. It is **not investment advice**, **not a financial product**, and **not a recommendation** to buy, sell, or hold any security.

## Read this before wiring real money

1. **Paper trading only in the default configuration.** Every strategy ships pointed at Alpaca's paper endpoint. Flipping to a live-money broker is a manual, explicit operator action, and the roadmap treats it as a multi-step promotion gated by approvals and track-record thresholds.
2. **No warranty.** The software is provided "as is" under the MIT License. There is no guarantee of correctness, fitness for any purpose, or freedom from bugs. Trading bugs can lose money very quickly.
3. **You are the risk owner.** If you run this against a live brokerage account, you alone are responsible for every order it places. The committee model, kill switches, and circuit breakers reduce risk but do not eliminate it.
4. **Past performance is not indicative of future results.** Track records in this repo, backtests, and any on-chain or paper-trading returns are retrospective and cannot be used to forecast future outcomes.
5. **Know your jurisdiction's rules.** Trading automation, algorithmic trading registration, margin rules, and pattern-day-trader rules vary by country and broker. Running this in production may require broker approval, disclosures, or registration depending on where you live.
6. **No one at Mattei Systems, ClaudePaw, or this repo's contributor list will answer support questions about live-money trading.** Issues and PRs are welcome for the code itself. Personal trading questions are out of scope.

## What this repo is for

- Reading and learning from a realistic agentic trading architecture
- Contributing improvements to the open-source codebase
- Running the engine in paper mode against Alpaca or a similar paper endpoint, for research and personal education
- Writing your own strategies, connectors, and risk rules on top of the framework

If you're not comfortable with all of the above, do not deploy this against a funded account.
