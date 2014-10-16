/**
 * Contains the letters that we are expecting to see in our Policy OCR.
 * The string returned by OCR should either be "Devicepolicies" or "Userpolicies," hence
 * the capital "U" and "D."
 * @type {string[]}
 */
var output = [
  'a',
  'b',
  'c',
  'd',
  'e',
  'f',
  'g',
  'h',
  'i',
  'j',
  'k',
  'l',
  'm',
  'n',
  'o',
  'p',
  'q',
  'r',
  's',
  't',
  'u',
  'v',
  'w',
  'x',
  'y',
  'z',
  'D',
  'U'
];

exports.letters = output;
