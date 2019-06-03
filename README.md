# Google BigQuery Chainlink Example

This example contract shows an option contract between a party and a counterparty on the price of ETH.

## Installation

```bash
npm install
```

## Test

```bash
npm test
```

## Deploy

If needed, edit the `truffle-config.js` config file to set the desired network to a different port. It assumes any network is running the RPC port on 8545.

```bash
npm run migrate:dev
```

For deploying to live networks, Truffle will use `truffle-hdwallet-provider` for your mnemonic and an RPC URL. Set your environment variables `$RPC_URL` and `$MNEMONIC` before running:

```bash
npm run migrate:live
```