pragma solidity 0.4.24;

import "openzeppelin-solidity/contracts/token/ERC20/ERC20.sol";
import "openzeppelin-solidity/contracts/token/ERC20/BasicToken.sol";
import "openzeppelin-solidity/contracts/token/ERC20/StandardToken.sol";

contract MockToken is ERC20, BasicToken, StandardToken {
  string public name = "Mock Token";
  string public symbol = "MOT";
  uint8 public decimals = 18;

  constructor() public {
    totalSupply_ = totalSupply_.add(10**24);
    balances[msg.sender] = balances[msg.sender].add(10**24);
  }
}