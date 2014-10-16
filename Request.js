/**
 * GoGuardian client-side request framework. Handles authentication (compRand cookie).
 * All of these methods proxy to their jQuery versions but return real Promises.
 */
var baseUrl = require('./GuardianServer').url,
    Promise = require('promise'),
    $ = require('jquery');


function ajax(relativePath, type, params) {
  return new Promise(function(resolve, reject) {
    $.ajax(baseUrl + relativePath, {
      type: type,
      data: params,
      dataType: 'json',
      beforeSend: function(request) {
        // Add Authorization header
        request.setRequestHeader('Authorization', localStorage.compRand);
        request.setRequestHeader('ExtensionVersion', chrome.app.getDetails().version || "Unknown");
      },
      error: function(jqXHR, textStatus, errorThrown) {
        reject(textStatus, errorThrown);
      },
      success: function(data) {
        resolve(data);
      }
    });
  });
}
exports.ajax = ajax;


function get(relativePath, params) {
  return ajax(relativePath, 'GET', params);
}
exports.get = get;


function post(relativePath, params) {
  return ajax(relativePath, 'POST', params);
}
exports.post = post;


function put(relativePath, params) {
  return ajax(relativePath, 'PUT', params);
}
exports.put = put;


function del(relativePath, params) {
  return ajax(relativePath, 'DELETE', params);
}
exports.del = del;
