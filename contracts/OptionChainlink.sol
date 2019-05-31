pragma solidity 0.4.24;

import "chainlink/contracts/ChainlinkClient.sol";
import "openzeppelin-solidity/contracts/ownership/Ownable.sol";
import "./lib/IERC20.sol";

/**
 * @title OptionChainlink is an example option contract which requests data from
 * the Chainlink network
 * @dev This contract is designed to work on multiple networks, including
 * local test networks
 */
contract OptionChainlink is ChainlinkClient, Ownable {

  using SafeMath for uint256;

  uint256 public constant SETTLEMENT_DELAY = 30 days;
  uint256 public constant AGREEMENT_VALID_PERIOD = 1 days;
  uint256 private constant PRECISION = 10**10;
  // uint256 private constant MULTIPLY_BY = 10**(18+PRECISION);

  IERC20 public stableCoin;

  bytes32 public initialJobId;
  bytes32 public optionJobId;
  uint256 public oraclePayment;

  struct PendingAgreement {
    address party;
    uint256 amount;
    uint256 premium;
  }

  struct Agreement {
    address party1;
    address party2;
    uint256 amount;
    uint256 transferAmount;
    uint256 premium;
    uint256 expiration;
    bool executed;
  }

  mapping(bytes32 => PendingAgreement) public pendingAgreements;
  mapping(bytes32 => bytes32) public pendingSettlement;
  mapping(bytes32 => Agreement) public agreements;

  event NewAgreement(
    address party,
    uint256 amount,
    uint256 transferAmount,
    uint256 premium,
    uint256 expiration
  );

  event EnteredAgreement(
    address party,
    address counterparty,
    uint256 amount,
    uint256 transferAmount
  );

  event AgreementSettled(
    address party,
    uint256 amount,
    uint256 transferAmount
  );

  /**
   * @notice Deploy the contract with a specified address for the LINK
   * and Oracle contract addresses
   * @dev Sets the storage for the specified addresses
   * @param _link The address of the LINK token contract
   * @param _oracle The address of the oracle contract
   * @param _stableCoin The address of the stablecoin token
   * @param _initialJobId The Job ID to create agreements
   * @param _optionJobId The Job ID to settle agreements
   * @param _oraclePayment The oracle payment amount
   */
  constructor
  (
    address _link,
    address _oracle,
    address _stableCoin,
    bytes32 _initialJobId,
    bytes32 _optionJobId,
    uint256 _oraclePayment
  )
    public
    Ownable()
  {
    if(_link == address(0)) {
      setPublicChainlinkToken();
    } else {
      setChainlinkToken(_link);
    }
    setChainlinkOracle(_oracle);
    setOraclePaymentAmount(_oraclePayment);
    setJobIds(_initialJobId, _optionJobId);

    stableCoin = IERC20(_stableCoin);
  }

  /**
   * @notice Sets the oracle payment amount.
   * @param _oraclePayment The oracle payment amount
   */
  function setOraclePaymentAmount(uint256 _oraclePayment) public onlyOwner() {
    oraclePayment = _oraclePayment;
  }

  /**
   * @notice Sets the Job IDs associated with the Chainlink requests
   * @param _initialJobId The job to retrieve the price of ETH
   * @param _optionJobId The job to settle the contract
   */
  function setJobIds(bytes32 _initialJobId, bytes32 _optionJobId) public onlyOwner() {
    initialJobId = _initialJobId;
    optionJobId = _optionJobId;
  }

  /**
   * @notice Allows a party to create an agreement to sell their deposit.
   * @param _premium The amount to be paid to the party regardless of settlement
   */
  function createAgreement(uint256 _premium) external payable hasValue() {
    Chainlink.Request memory req = buildChainlinkRequest(initialJobId, this, this.initializeAgreement.selector);
    pendingAgreements[sendChainlinkRequest(req, oraclePayment)] = PendingAgreement(
      msg.sender,
      msg.value,
      _premium
    );
  }

  /**
   * @notice The Chainlink oracle responds with the transfer amount, which is multiplied
   * off-chain by 100000000.
   * @param _requestId The request ID of the Chainlink request
   * @param _transferAmount The calculated USD value of ETH
   */
  function initializeAgreement(bytes32 _requestId, uint256 _transferAmount)
    public
    recordChainlinkFulfillment(_requestId)
  {
    PendingAgreement memory pa = pendingAgreements[_requestId];
    delete pendingAgreements[_requestId];
    uint256 expiration = now + AGREEMENT_VALID_PERIOD;
    bytes32 agrKey = keccak256(abi.encodePacked(pa.party, pa.amount, pa.premium));
    // Prevents duplicate agreements
    require(agreements[agrKey].amount == 0, "Agreement already exists");
    // Value of 1 ETH * precision * the amount of ETH in the agreement / 1 ether
    uint256 transferAmount = _transferAmount.mul(PRECISION).mul(pa.amount).div(1 ether);
    agreements[agrKey] = Agreement(pa.party, address(0), pa.amount, transferAmount, pa.premium, expiration, false);
    emit NewAgreement(pa.party, pa.amount, pa.premium, transferAmount, expiration);
  }

  /**
   * @notice Allows the creator of an agreement to withdraw their deposit after the agreement
   * has expired.
   * @param _amount The deposit amount sent for the agreement
   * @param _premium The premium amount specified for the agreement
   */
  function endExpiredAgreement
  (
    uint256 _amount,
    uint256 _premium
  )
    external
  {
    bytes32 agrKey = keccak256(abi.encodePacked(msg.sender, _amount, _premium));
    Agreement memory agr = agreements[agrKey];
    require(agr.expiration < now, "Agreement is not expired");
    require(agr.amount > 0, "Agreement does not exist");
    delete agreements[agrKey];
    msg.sender.transfer(agr.amount);
  }

  /**
   * @notice Called by a party wanting to enter into an agreement with another party.
   * @param _counterParty The counter party to party1 of the agreement
   * @param _amount The amount set for the agreement
   * @param _premium The premium amount specified for the agreement
   */
  function enterAgreement
  (
    address _counterParty,
    uint256 _amount,
    uint256 _premium
  )
    external
    payable
    hasValue()
  {
    bytes32 agrKey = keccak256(abi.encodePacked(_counterParty, _amount, _premium));
    Agreement memory agr = agreements[agrKey];
    require(agr.amount > 0, "Agreement does not exist");
    require(agr.expiration > now, "Agreement is expired");
    require(agr.party2 == address(0), "Agreement already has counterparty");
    require(msg.value >= agr.premium, "Premium amount not met");
    agreements[agrKey].party2 = msg.sender;
    Chainlink.Request memory req = buildChainlinkRequest(optionJobId, this, this.settleAgreement.selector);
    req.addUint("until", now + SETTLEMENT_DELAY);
    pendingSettlement[sendChainlinkRequest(req, oraclePayment)] = agrKey;
    agr.party1.transfer(msg.value); // Pay the premium to party1
    emit EnteredAgreement(_counterParty, msg.sender, agr.amount, agr.transferAmount);
  }

  /**
   * @notice Called by the purchasing party to execute the agreement. Will transfer
   * the dollar amount of stablecoin for purchasing to the contract's address.
   * @dev Requires that Party2 has approved this contract's address for transferFrom.
   * @param _counterParty The counter party to party1 of the agreement
   * @param _amount The amount set for the agreement
   * @param _premium The premium amount specified for the agreement
   */
  function executeAgreement
  (
    address _counterParty,
    uint256 _amount,
    uint256 _premium
  )
    external
  {
    bytes32 agrKey = keccak256(abi.encodePacked(_counterParty, _amount, _premium));
    Agreement memory agr = agreements[agrKey];
    require(agr.party2 == msg.sender, "Incorrect agreement");
    agreements[agrKey].executed = true;
    require(stableCoin.transferFrom(agr.party2, address(this), agr.transferAmount), "OptionChainlink not approved");
  }

  /**
   * @notice The settleAgreement method from requests created by this contract
   * @dev The recordChainlinkFulfillment protects this function from being called
   * by anyone other than the oracle address that the request was sent to
   * @param _requestId The ID that was generated for the request
   */
  function settleAgreement(bytes32 _requestId, uint256)
    public
    recordChainlinkFulfillment(_requestId)
  {
    Agreement memory agr = agreements[pendingSettlement[_requestId]];
    delete agreements[pendingSettlement[_requestId]];
    delete pendingSettlement[_requestId];
    require(agr.amount > 0, "Agreement already executed");
    if (agr.executed) {
      // Party1 gets paid stablecoin
      stableCoin.transfer(agr.party1, agr.transferAmount);
      // Party2 gets paid ETH
      agr.party2.transfer(agr.amount);
    } else {
      // Send Party1 their deposit back
      agr.party1.transfer(agr.amount);
    }
  }

  /**
   * @notice Allows the owner to withdraw any LINK balance on the contract
   */
  function withdrawLink() public onlyOwner() {
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
	  onlyOwner()
  {
    cancelChainlinkRequest(_requestId, _payment, _callbackFunctionId, _expiration);
  }

  modifier hasValue() {
    require(msg.value > 0, "No payment given");
    _;
  }
}