'use strict'

const h = require('chainlink-test-helpers')

contract('MyContract', accounts => {
  const LinkToken = artifacts.require('LinkToken.sol')
  const Oracle = artifacts.require('Oracle.sol')
  const MyContract = artifacts.require('MyContract.sol')

  const defaultAccount = accounts[0]
  const oracleNode = accounts[1]
  const stranger = accounts[2]
  const maintainer = accounts[3]
  const party1 = accounts[4]
  const party2 = accounts[5]
  const jobId = web3.utils.toHex('14d31bb7c28546e3af7d3cef604b3a2c')
  const payment = web3.utils.toWei('1')
  const date = '2019-05-25'
  const callValue = new web3.utils.BN(7000000000)
  const payoutValue = 100

  let link, oc, cc

  beforeEach(async () => {
    link = await LinkToken.new()
    oc = await Oracle.new(link.address, { from: defaultAccount })
    cc = await MyContract.new(link.address, { from: maintainer })
    await oc.setFulfillmentPermission(oracleNode, true, {
      from: defaultAccount
    })
  })

  describe('#createRequest', () => {
    context('without LINK', () => {
      it('reverts', async () => {
        await h.assertActionThrows(async () => {
          await cc.requestGasPriceAtDate(
            party2,
            callValue,
            oc.address,
            jobId,
            payment,
            date,
            { from: party1, value: payoutValue }
          )
        })
      })
    })

    context('with LINK', () => {
      let request

      beforeEach(async () => {
        await link.transfer(cc.address, web3.utils.toWei('1', 'ether'))
      })

      context('sending a request to a specific oracle contract address', () => {
        it('triggers a log event in the new Oracle contract', async () => {
          let tx = await cc.requestGasPriceAtDate(
            party2,
            callValue,
            oc.address,
            jobId,
            payment,
            date,
            { from: party1, value: payoutValue }
          )
          request = h.decodeRunRequest(tx.receipt.rawLogs[3])
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
  })

  describe('#fulfill', () => {
    const expectedDiff = new web3.utils.BN(100)
    let request
    let beforeParty1Balance
    let beforeParty2Balance

    context('when the answer is greater than the estimated value', () => {
      const response = web3.eth.abi.encodeParameter('uint256', '7100000000')
      beforeEach(async () => {
        await link.transfer(cc.address, web3.utils.toWei('1', 'ether'))
        let tx = await cc.requestGasPriceAtDate(
          party2,
          callValue,
          oc.address,
          jobId,
          payment,
          date,
          { from: party1, value: payoutValue }
        )
        beforeParty1Balance = new web3.utils.BN(await web3.eth.getBalance(party1))
        beforeParty2Balance = new web3.utils.BN(await web3.eth.getBalance(party2))
        request = h.decodeRunRequest(tx.receipt.rawLogs[3])
        await h.fulfillOracleRequest(oc, request, response, { from: oracleNode })
      })

      it('pays party2', async () => {
        const afterParty1Balance = new web3.utils.BN(await web3.eth.getBalance(party1))
        const afterParty2Balance = new web3.utils.BN(await web3.eth.getBalance(party2))
        const party2BalanceChange = afterParty2Balance.sub(beforeParty2Balance)
        assert.isTrue(beforeParty1Balance.eq(afterParty1Balance))
        assert.isTrue(party2BalanceChange.eq(expectedDiff))
      })
    })

    context('when the answer is less than the estimated value', () => {
      const response = web3.eth.abi.encodeParameter('uint256', '6900000000')
      beforeEach(async () => {
        await link.transfer(cc.address, web3.utils.toWei('1', 'ether'))
        let tx = await cc.requestGasPriceAtDate(
          party2,
          callValue,
          oc.address,
          jobId,
          payment,
          date,
          { from: party1, value: payoutValue }
        )
        beforeParty1Balance = new web3.utils.BN(await web3.eth.getBalance(party1))
        beforeParty2Balance = new web3.utils.BN(await web3.eth.getBalance(party2))
        request = h.decodeRunRequest(tx.receipt.rawLogs[3])
        await h.fulfillOracleRequest(oc, request, response, { from: oracleNode })
      })

      it('pays party1', async () => {
        const afterParty1Balance = new web3.utils.BN(await web3.eth.getBalance(party1))
        const afterParty2Balance = new web3.utils.BN(await web3.eth.getBalance(party2))
        const party1BalanceChange = afterParty1Balance.sub(beforeParty1Balance)
        assert.isTrue(beforeParty2Balance.eq(afterParty2Balance))
        assert.isTrue(party1BalanceChange.eq(expectedDiff))
      })
    })


    context('when my contract does not recognize the request ID', () => {
      const response = web3.eth.abi.encodeParameter('uint256', '6900000000')
      const otherId = web3.utils.toHex('otherId')

      beforeEach(async () => {
        request.id = otherId
      })

      it('does not accept the data provided', async () => {
        await h.assertActionThrows(async () => {
          await h.fulfillOracleRequest(oc, request, response, {
            from: oracleNode
          })
        })
      })
    })

    context('when called by anyone other than the oracle contract', () => {
      const response = web3.eth.abi.encodeParameter('uint256', '6900000000')
      it('does not accept the data provided', async () => {
        await h.assertActionThrows(async () => {
          await cc.fulfill(request.id, response, { from: stranger })
        })
      })
    })
  })

  describe('#cancelRequest', () => {
    let request

    beforeEach(async () => {
      await link.transfer(cc.address, web3.utils.toWei('1', 'ether'))
      let tx = await cc.requestGasPriceAtDate(
        party2,
        callValue,
        oc.address,
        jobId,
        payment,
        date,
        { from: party1, value: payoutValue }
      )
      request = h.decodeRunRequest(tx.receipt.rawLogs[3])
    })

    context('before the expiration time', () => {
      it('cannot cancel a request', async () => {
        await h.assertActionThrows(async () => {
          await cc.cancelRequest(
            request.id,
            request.payment,
            request.callbackFunc,
            request.expiration,
            { from: maintainer }
          )
        })
      })
    })

    context('after the expiration time', () => {
      beforeEach(async () => {
        await h.increaseTime5Minutes()
      })

      context('when called by a non-owner', () => {
        it('cannot cancel a request', async () => {
          await h.assertActionThrows(async () => {
            await cc.cancelRequest(
              request.id,
              request.payment,
              request.callbackFunc,
              request.expiration,
              { from: stranger }
            )
          })
        })
      })

      context('when called by an owner', () => {
        it('can cancel a request', async () => {
          await cc.cancelRequest(
            request.id,
            request.payment,
            request.callbackFunc,
            request.expiration,
            { from: maintainer }
          )
        })
      })
    })
  })

  describe('#withdrawLink', () => {
    beforeEach(async () => {
      await link.transfer(cc.address, web3.utils.toWei('1', 'ether'))
    })

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
        assert.equal(afterBalance, web3.utils.toWei('1', 'ether'))
      })
    })
  })
})
