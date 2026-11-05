# SignerRequiredError tells you to pass an account, but an account address still fails

Severity: normal
Area: SDK

## Steps to reproduce

```ts
const markets = new SomniaMarkets({ chain, indexerUrl, addresses: SOMNIA_HIDEKI_TESTNET_ADDRESSES, wsRpcUrl,
  account: '0x39791a9Df0bb96EBaEEaE2C6754bB76EbD09C67D' })
await markets.trader.claimPerpVoucher({ marginBank: '0x478769E1177C0773c43A593DCCc4Ad15F15F1394' })
```

Same with no signer option at all.

## Expected

Either `account` (as the hint says) makes the trader usable, or the message names what actually works.

## Actual

Both throw the same text:

```
SignerRequiredError: @somnia-chain/markets-sdk: createTrader is authenticated — construct SomniaMarkets with a privateKey / account / walletClient
```

A bare `account` address only sets the read identity, so following the hint does not help. Suggest: "pass
privateKey, a viem LocalAccount, or a walletClient; a plain address is read-only".

## Evidence

Output above, from a script run against Tokyo testnet with SDK 0.32.1.

## Environment

- `@somnia-chain/markets-sdk` 0.32.1, viem 2.57.14, Node 22
- Somnia Tokyo testnet (chain 50383), RPC `https://api.hideki2.infra.testnet.somnia.network`
- Wallet `0x39791a9Df0bb96EBaEEaE2C6754bB76EbD09C67D`
- 1 Nov 2026
