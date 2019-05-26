pragma solidity 0.4.24;

import "chainlink/contracts/ChainlinkClient.sol";
import "openzeppelin-solidity/contracts/ownership/Ownable.sol";

/**
 * @title MyContract is an example contract which requests data from
 * the Chainlink network
 * @dev This contract is designed to work on multiple networks, including
 * local test networks
 */
contract MyContract is ChainlinkClient, Ownable {

  struct Agreement {
    address party1;
    address party2;
    uint256 amount;
    uint256 callValue;
  }

  mapping(bytes32 => Agreement) public agreements;

  event Payout(
    address party,
    uint256 amount,
    uint256 callValue
  );
  event NewAgreement(
    address party,
    address counterparty,
    uint256 amount,
    uint256 callValue
  );

  /**
   * @notice Deploy the contract with a specified address for the LINK
   * and Oracle contract addresses
   * @dev Sets the storage for the specified addresses
   * @param _link The address of the LINK token contract
   */
  constructor(address _link) public {
    if(_link == address(0)) {
      setPublicChainlinkToken();
    } else {
      setChainlinkToken(_link);
    }
  }

  /**
   * @notice Returns the address of the LINK token
   * @dev This is the public implementation for chainlinkTokenAddress, which is
   * an internal method of the ChainlinkClient contract
   */
  function getChainlinkToken() public view returns (address) {
    return chainlinkTokenAddress();
  }

  /**
   * @notice Creates a request to the specified Oracle contract address,
   * when called, will assume the caller is party1.
   * @dev This function ignores the stored Oracle contract address and
   * will instead send the request to the address specified.
   * @param _counterparty The counterparty to party1 of the agreement
   * @param _callValue The estimated value of the answer for the request
   * @param _oracle The Oracle contract address to send the request to
   * @param _jobId The bytes32 JobID to be executed
   * @param _payment The amount of payment in LINK to send to the oracle
   * @param _date The date to calculate the gas price
   */
  function requestGasPriceAtDate(
    address _counterparty,
    uint256 _callValue,
    address _oracle,
    bytes32 _jobId,
    uint256 _payment,
    string _date
  )
    public
    payable
  {
    require(msg.value > 0, "No payment given");
    Chainlink.Request memory req = buildChainlinkRequest(_jobId, this, this.fulfill.selector);
    req.add("date", _date);
    req.add("action", "date");
    req.add("copyPath", "gasPrice");
    req.addInt("times", 10000);
    agreements[sendChainlinkRequestTo(_oracle, req, _payment)] = Agreement(msg.sender, _counterparty, msg.value, _callValue);
    emit NewAgreement(msg.sender, _counterparty, msg.value, _callValue);
  }

  /**
   * @notice The fulfill method from requests created by this contract
   * @dev The recordChainlinkFulfillment protects this function from being called
   * by anyone other than the oracle address that the request was sent to
   * @param _requestId The ID that was generated for the request
   * @param _data The answer provided by the oracle
   */
  function fulfill(bytes32 _requestId, uint256 _data)
    public
    recordChainlinkFulfillment(_requestId)
  {
    Agreement memory agr = agreements[_requestId];
    delete agreements[_requestId];
    if (agr.callValue < _data) {
      emit Payout(agr.party2, agr.amount, _data);
      agr.party2.transfer(agr.amount);
    } else {
      emit Payout(agr.party1, agr.amount, _data);
      agr.party1.transfer(agr.amount);
    }
  }

  /**
   * @notice Allows the owner to withdraw any LINK balance on the contract
   */
  function withdrawLink() public onlyOwner {
    LinkTokenInterface link = LinkTokenInterface(chainlinkTokenAddress());
    require(link.transfer(msg.sender, link.balanceOf(address(this))), "Unable to transfer");
  }

  /**
   * @notice Call this method if no response is received within 5 minutes
   * @param _requestId The ID that was generated for the request to cancel
   * @param _payment The payment specified for the request to cancel
   * @param _callbackFunctionId The bytes4 callback function ID specified for
   * the request to cancel
   * @param _expiration The expiration generated for the request to cancel
   */
  function cancelRequest(
    bytes32 _requestId,
    uint256 _payment,
    bytes4 _callbackFunctionId,
    uint256 _expiration
  )
    public
	  onlyOwner
  {
    cancelChainlinkRequest(_requestId, _payment, _callbackFunctionId, _expiration);
  }
}