/**
 * Attempts to retry a Promise Function with ever-increasing backoff.
 * @param promiseFunctionToRetry
 * @param {number?} backoff
 * @returns {Promise}
 */
module.exports = function(promiseFunctionToRetry, backoff) {
  return new Promise(function(resolve) {
    var currentBackoff = backoff || 1000;
    var backoffStep = currentBackoff;

    var retry = function() {
      promiseFunctionToRetry()
          .then(resolve, function() {
            setTimeout(retry, currentBackoff);
            var temp = currentBackoff;
            currentBackoff += backoffStep;
            backoffStep = temp;
          });
    };

    retry();
  });
};
