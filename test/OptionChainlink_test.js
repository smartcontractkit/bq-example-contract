const h = require('chainlink-test-helpers')
const {
  BN,
  balance,
  constants,
  expectEvent,
  expectRevert,
  time
} = require('openzeppelin-test-helpers')

contract('OptionChainlink', accounts => {
  const LinkToken = artifacts.require('LinkToken.sol')
  const Oracle = artifacts.require('Oracle.sol')
  const MockStableCoin = artifacts.require('MockToken.sol')
  const OptionChainlink = artifacts.require('OptionChainlink.sol')

  const defaultAccount = accounts[0]
  const oracleNode = accounts[1]
  const stranger = accounts[2]
  const maintainer = accounts[3]
  const party1 = accounts[4]
  const party2 = accounts[5]
  // const jobId = web3.utils.toHex('14d31bb7c28546e3af7d3cef604b3a2c')
  const initialJobId = '0x' + Buffer.from('2702448d062042b6a174a1f24017618d').toString('hex')
  const optionJobId = '0x' + Buffer.from('a7ab70d561d34eb49e9b1612fd2e044b').toString('hex')
  const oraclePayment = web3.utils.toWei('1')
  const callValue = new BN(30000000000) // 300.00000000
  const precision = new BN(10**10)
  const premium = web3.utils.toWei('.01')
  const agreementValue = web3.utils.toWei('1')
  const agrKey = web3.utils.soliditySha3(party1, agreementValue, premium)

  let link, oc, cc, mst

  beforeEach(async () => {
    link = await LinkToken.new()
    mst = await MockStableCoin.new()
    oc = await Oracle.new(link.address, { from: defaultAccount })
    cc = await OptionChainlink.new(
      link.address,
      oc.address,
      mst.address,
      initialJobId,
      optionJobId,
      oraclePayment,
      { from: maintainer })
    await oc.setFulfillmentPermission(oracleNode, true, {
      from: defaultAccount
    })
    await link.transfer(cc.address, web3.utils.toWei('10'))
    await mst.transfer(party2, web3.utils.toWei('1000'))
  })

  describe('#setOraclePaymentAmount', () => {
    context('when called by a stranger', () => {
      it('reverts', async () => {
        await expectRevert.unspecified(
          cc.setOraclePaymentAmount(oraclePayment, {from: stranger})
        )
      })
    })

    context('when called by the owner', () => {
      it('sets the oracle payment amount', async () => {
        await cc.setOraclePaymentAmount(oraclePayment, {from: maintainer})
        assert.equal(await cc.oraclePayment(), oraclePayment)
      })
    })
  })

  describe('#setJobIds', () => {
    context('when called by a stranger', () => {
      it('reverts', async () => {
        await expectRevert.unspecified(
          cc.setJobIds(initialJobId, optionJobId, {from: stranger})
        )
      })
    })

    context('when called by the owner', () => {
      it('sets the job IDs', async () => {
        await cc.setJobIds(initialJobId, optionJobId, {from: maintainer})
        assert.equal(await cc.initialJobId(), initialJobId)
        assert.equal(await cc.optionJobId(), optionJobId)
      })
    })
  })

  describe('#createAgreement', () => {
    it('rejects agreements with 0 ETH', async () => {
      await expectRevert(
        cc.createAgreement(premium, {from: party1}),
        'No payment given'
      )
    })

    it('accepts ETH deposits', async () => {
      assert.equal(await web3.eth.getBalance(cc.address), 0)
      await cc.createAgreement(premium, {from: party1, value: agreementValue})
      assert.equal(await web3.eth.getBalance(cc.address), agreementValue)
    })

    context('when an agreement is created', () => {
      let request, tx

      beforeEach(async () => {
        tx = await cc.createAgreement(premium, {from: party1, value: agreementValue})
        request = h.decodeRunRequest(tx.receipt.rawLogs[3])
      })

      it('creates a Chainlink request', async () => {
        assert.equal(oc.address, tx.receipt.rawLogs[3].address)
        assert.equal(
          request.topic,
          web3.utils.keccak256(
            'OracleRequest(bytes32,address,bytes32,uint256,address,bytes4,uint256,uint256,bytes)'
          )
        )
      })
    })
  })

  describe('#initializeAgreement', () => {
    const expected = new BN('300000000000000000000')
    const response = web3.eth.abi.encodeParameter('uint256', 30000000000)
    let request, tx

    beforeEach(async () => {
      tx = await cc.createAgreement(premium, {from: party1, value: agreementValue})
      request = h.decodeRunRequest(tx.receipt.rawLogs[3])
      await h.fulfillOracleRequest(oc, request, response, { from: oracleNode })
    })

    it('initializes the agreement with the value from Chainlink', async () => {
      const agreement = await cc.agreements(agrKey)
      assert.equal(agreement.party1, party1)
      assert.equal(agreement.party2, constants.ZERO_ADDRESS)
      assert.equal(agreement.amount, agreementValue)
      assert.isTrue(agreement.transferAmount.eq(expected))
    })
  })

  describe('#endExpiredAgreement', () => {
    let request, tx
    const response = web3.eth.abi.encodeParameter('uint256', 30000000000)

    it('reverts if the agreement does not exist', async () => {
      await expectRevert(
        cc.endExpiredAgreement(agreementValue, premium, {from: party1}),
        'Agreement does not exist'
      )
    })

    context('if the agreement is not expired', () => {
      beforeEach(async () => {
        tx = await cc.createAgreement(premium, {from: party1, value: agreementValue})
        request = h.decodeRunRequest(tx.receipt.rawLogs[3])
        await h.fulfillOracleRequest(oc, request, response, { from: oracleNode })
      })

      it('reverts', async () => {
        await expectRevert(
          cc.endExpiredAgreement(agreementValue, premium, {from: party1}),
          'Agreement is not expired'
        )
      })
    })

    context('if the agreement is expired', () => {
      beforeEach(async () => {
        tx = await cc.createAgreement(premium, {from: party1, value: agreementValue})
        request = h.decodeRunRequest(tx.receipt.rawLogs[3])
        await h.fulfillOracleRequest(oc, request, response, { from: oracleNode })
        await time.increase(86401) // 24 hours + 1 second
        await time.advanceBlock()
      })

      it('deletes the agreement', async () => {
        await cc.endExpiredAgreement(agreementValue, premium, {from: party1})
        const agreement = await cc.agreements(agrKey)
        assert.equal(agreement.party1, 0)
        assert.equal(agreement.party2, 0)
        assert.equal(agreement.amount, 0)
        assert.equal(agreement.transferAmount, 0)
      })

      it('sends the agreement amount back to party1', async () => {
        const beforeBalance = new BN(await web3.eth.getBalance(party1))
        await cc.endExpiredAgreement(agreementValue, premium, {from: party1})
        const afterBalance = new BN(await web3.eth.getBalance(party1))
        assert.isTrue(afterBalance.gt(beforeBalance))
      })
    })
  })

  describe('#enterAgreement', () => {
    let request, tx
    const response = web3.eth.abi.encodeParameter('uint256', 30000000000)

    it('reverts if the agreement does not exist', async () => {
      await expectRevert(
        cc.enterAgreement(party1, agreementValue, premium, {from: party2, value: premium}),
        'Agreement does not exist'
      )
    })

    context('if the agreement does exist', () => {
      beforeEach(async () => {
        tx = await cc.createAgreement(premium, {from: party1, value: agreementValue})
        request = h.decodeRunRequest(tx.receipt.rawLogs[3])
        await h.fulfillOracleRequest(oc, request, response, { from: oracleNode })
      })

      it('reverts if it already has a counterparty', async () => {
        await cc.enterAgreement(party1, agreementValue, premium, {from: stranger, value: premium})
        await expectRevert(
          cc.enterAgreement(party1, agreementValue, premium, {from: party2, value: premium}),
          'Agreement already has counterparty'
        )
      })

      it('reverts if no payment is given', async () => {
        await expectRevert(
          cc.enterAgreement(party1, agreementValue, premium, {from: party2}),
          'No payment given'
        )
      })

      it('reverts if the premium is not met', async () => {
        await expectRevert(
          cc.enterAgreement(party1, agreementValue, premium, {from: party2, value: 1}),
          'Premium amount not met'
        )
      })

      it('pays party1 the premium', async () => {
        const beforeBalance = new BN(await web3.eth.getBalance(party1))
        await cc.enterAgreement(party1, agreementValue, premium, {from: party2, value: premium})
        const afterBalance = new BN(await web3.eth.getBalance(party1))
        assert.isTrue(afterBalance.eq(beforeBalance.add(new BN(premium))))
      })

      it('creates a Chainlink request', async () => {
        const { logs } = await cc.enterAgreement(party1, agreementValue, premium, {from: party2, value: premium})
        await expectEvent.inLogs(logs, 'ChainlinkRequested')
      })

      it('creates an entry in the pendingSettlement mapping', async () => {
        const newTx = await cc.enterAgreement(party1, agreementValue, premium, {from: party2, value: premium})
        const newRequest = h.decodeRunRequest(newTx.receipt.rawLogs[3])
        const ps = await cc.pendingSettlement(newRequest.id)
        assert.equal(ps, agrKey)
      })
    })
  })

  describe('#executeAgreement', () => {
    it('reverts if the agreement does not exit', async () => {
      await expectRevert(
        cc.executeAgreement(party1, agreementValue, premium, {from: party2}),
        'Incorrect agreement'
      )
    })

    context('when the agreement exists', () => {
      let request, tx
      const response = web3.eth.abi.encodeParameter('uint256', 30000000000)

      beforeEach(async () => {
        tx = await cc.createAgreement(premium, {from: party1, value: agreementValue})
        request = h.decodeRunRequest(tx.receipt.rawLogs[3])
        await h.fulfillOracleRequest(oc, request, response, { from: oracleNode })
        await cc.enterAgreement(party1, agreementValue, premium, {from: party2, value: premium})
        const agreement = await cc.agreements(agrKey)
        await mst.approve(cc.address, agreement.transferAmount, {from: party2})
      })

      it('flags the agreement as executed', async () => {
        await cc.executeAgreement(party1, agreementValue, premium, {from: party2})
        const agreement = await cc.agreements(agrKey)
        assert.isTrue(agreement.executed)
      })

      it('stores the transfer amount in the agreement', async () => {
        const expected = new BN('300000000000000000000')
        await cc.executeAgreement(party1, agreementValue, premium, {from: party2})
        const agreement = await cc.agreements(agrKey)
        assert.isTrue(agreement.transferAmount.eq(expected))
      })

      it('transfers the agreement amount to the contract', async () => {
        assert.equal(await mst.balanceOf(cc.address), 0)
        await cc.executeAgreement(party1, agreementValue, premium, {from: party2})
        assert.equal(await mst.balanceOf(cc.address), web3.utils.toWei('300'))
      })
    })
  })

  describe('#settleAgreement', () => {
    let request, request2, tx, tx2
    const response = web3.eth.abi.encodeParameter('uint256', 30000000000)
    const response2 = web3.eth.abi.encodeParameter('uint256', 0)

    context('if the contract has been executed', () => {
      beforeEach(async () => {
        tx = await cc.createAgreement(premium, {from: party1, value: agreementValue})
        request = h.decodeRunRequest(tx.receipt.rawLogs[3])
        await h.fulfillOracleRequest(oc, request, response, { from: oracleNode })
        tx2 = await cc.enterAgreement(party1, agreementValue, premium, {from: party2, value: premium})
        request2 = h.decodeRunRequest(tx2.receipt.rawLogs[3])
        const agreement = await cc.agreements(agrKey)
        await mst.approve(cc.address, agreement.transferAmount, {from: party2})
        await cc.executeAgreement(party1, agreementValue, premium, {from: party2})
      })

      it('sends stablecoin to Party1', async () => {
        assert.equal(await mst.balanceOf(party1), 0)
        assert.equal(await mst.balanceOf(cc.address), web3.utils.toWei('300'))
        await h.fulfillOracleRequest(oc, request2, response2, { from: oracleNode })
        assert.equal(await mst.balanceOf(cc.address), 0)
        assert.equal(await mst.balanceOf(party1), web3.utils.toWei('300'))
      })

      it('sends ETH to Party2', async () => {
        const party2Tracker = await balance.tracker(party2)
        assert.equal(await web3.eth.getBalance(cc.address), agreementValue)
        await h.fulfillOracleRequest(oc, request2, response2, { from: oracleNode })
        assert.equal((await party2Tracker.delta()).toString(), agreementValue)
        assert.equal(await web3.eth.getBalance(cc.address), 0)
      })
    })

    context('if the contract has not been executed', () => {
      let request, request2, tx, tx2
      const response = web3.eth.abi.encodeParameter('uint256', 30000000000)
      const response2 = web3.eth.abi.encodeParameter('uint256', 0)

      beforeEach(async () => {
        tx = await cc.createAgreement(premium, {from: party1, value: agreementValue})
        request = h.decodeRunRequest(tx.receipt.rawLogs[3])
        await h.fulfillOracleRequest(oc, request, response, { from: oracleNode })
        tx2 = await cc.enterAgreement(party1, agreementValue, premium, {from: party2, value: premium})
        request2 = h.decodeRunRequest(tx2.receipt.rawLogs[3])
        const agreement = await cc.agreements(agrKey)
        await mst.approve(cc.address, agreement.transferAmount, {from: party2})
      })

      it('sends Party1 their deposit back', async () => {
        const party1Tracker = await balance.tracker(party1)
        assert.equal(await web3.eth.getBalance(cc.address), agreementValue)
        await h.fulfillOracleRequest(oc, request2, response2, { from: oracleNode })
        assert.equal((await party1Tracker.delta()).toString(), agreementValue)
        assert.equal(await web3.eth.getBalance(cc.address), 0)
      })
    })
  })

  describe('#withdrawLink', () => {
    context('when called by a non-owner', () => {
      it('cannot withdraw', async () => {
        await h.assertActionThrows(async () => {
          await cc.withdrawLink({ from: stranger })
        })
      })
    })

    context('when called by the owner', () => {
      it('transfers LINK to the owner', async () => {
        const beforeBalance = await link.balanceOf(maintainer)
        assert.equal(beforeBalance, '0')
        await cc.withdrawLink({ from: maintainer })
        const afterBalance = await link.balanceOf(maintainer)
        assert.equal(afterBalance.toString(), web3.utils.toWei('10'))
      })
    })
  })
})
