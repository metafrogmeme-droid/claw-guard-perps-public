# Bounty lists Somnia Agents as a plus, but the Agents platform is not deployed on Tokyo testnet, where perps run

Severity: normal
Area: docs

## Steps to reproduce

1. The Perps Bounty says MVPs get a plus for using Somnia primitives "such as Reactivity or Somnia Agents". Perps testnet is Tokyo (chain 50383).
2. The Somnia Agents docs ([Quickstart](https://docs.somnia.network/agents/invoking-agents/quickstart), [Invoking from Solidity](https://docs.somnia.network/agents/invoking-agents/from-solidity)) list the platform contract `0x037Bb9C718F3f7fe5eCBDB0b600D607b52706776` for testnet chain 50312 and `0x5E5205CF39E766118C01636bED000A54D93163E6` for mainnet 5031. Tokyo is not mentioned.
3. Check the code:

```sh
curl -s -X POST https://api.hideki2.infra.testnet.somnia.network -H 'content-type: application/json' \
  -d '{"jsonrpc":"2.0","id":1,"method":"eth_getCode","params":["0x037Bb9C718F3f7fe5eCBDB0b600D607b52706776","latest"]}'
# {"jsonrpc":"2.0","id":1,"result":"0x"}          (Tokyo, chainId 0xc4cf = 50383)

curl -s -X POST https://dream-rpc.somnia.network -H 'content-type: application/json' \
  -d '{"jsonrpc":"2.0","id":1,"method":"eth_getCode","params":["0x037Bb9C718F3f7fe5eCBDB0b600D607b52706776","latest"]}'
# {"jsonrpc":"2.0","id":1,"result":"0x6080…"}     (Somnia testnet, chainId 0xc488 = 50312)
```

## Expected

Either an Agents platform address on Tokyo, or a note in the bounty or perps docs on how a perps MVP is meant to use Agents. For example: "Agents run on chain 50312; call them from there and bridge the result off-chain."

## Actual

No platform contract on 50383. A perps contract or bot on Tokyo cannot `createRequest` to an agent on the same chain. Using Agents means a second chain, a second funded key and an off-chain relay of the answer back to Tokyo. Every builder who reads "plus: Somnia Agents" hits this. (Reactivity, the other primitive named, does work on Tokyo through `somnia_watch`.)

## Evidence

- `eth_getCode` results above, run 1 Nov 2026 18:48 CET (17:48 UTC).
- `SOMNIA_HIDEKI_TESTNET_ADDRESSES` in `@somnia-chain/markets-sdk` 0.32.1 has no agents entry.

## Environment

- `@somnia-chain/markets-sdk` 0.32.1, Node 22, curl
- Somnia Tokyo testnet (chain 50383), RPC `https://api.hideki2.infra.testnet.somnia.network`, and Somnia testnet (chain 50312), RPC `https://dream-rpc.somnia.network`
- Wallet `0x39791a9Df0bb96EBaEEaE2C6754bB76EbD09C67D` (no transaction needed)
- 1 Nov 2026
