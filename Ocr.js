var Promise = require('promise'),
    post = require('./Request.js').post,
    backoff = require('./backoff'),
    policyLetters = require('./policyLetters').letters;


function Ocr() {
  this._initialized = false;
  this._loadArr = [];
  this._boundOnContentScriptListener = this._contentScriptListener.bind(this);
}
module.exports = Ocr;


Ocr.prototype._contentScriptListener = function(request) {
  var self = this;
  if (request.type == "cbpolicy") {
    return new Promise.resolve(request)
        .then(self._getCurrentPage.bind(self))
        .then(self._openPolicyPage.bind(self))
        .then(self._handlePolicyPage.bind(self))
        .then(self._awecr.bind(self));
  }
};


/**
 * Get the current window ID the user is working on and refocuses on it after
 * creating the mockup-hosted chrome policy page.
 * Creates a listener for the content script message from said page, which contains
 * the offset of the element we want to OCR.
 * Create/capture the window of chrome://policy using that offset to target the right spot.
 * Pass it to the Awecr (AwesomeOCR!) function.
 */
Ocr.prototype.checkManaged = function() {
  var self = this;
  // Check the platform the extension is running on
  // if its any other OS other than Chrome, default to unmanaged
  // else pass it to OCR to figure if managed or unmanaged.
  chrome.runtime.getPlatformInfo(function(info) {
    // Get the host OS.
    if (info.os == "cros") {
      // Content script Listener.
      chrome.runtime.onMessage.removeListener(self._boundOnContentScriptListener);
      chrome.runtime.onMessage.addListener(self._boundOnContentScriptListener);

      // Popup the fake policy page to get the offsets on user's Chromebook.
      // Refocus to user's current window instantaneously after creating the window.
      return Promise.resolve(self._initialized)
          .then(function (initialized) {
            if (!initialized) {
              return self._initialize()
                  .then(self._decode.bind(self));
            }
          })
          .then(self._getCurrentPage.bind(self))
          .then(self._openFakePolicyPage.bind(self));
    } else { // This cannot be a managed device, force it to save as such.
      return Promise.resolve({
        type: 'policy',
        result: 'Userpolicies'
      })
          .then(self._checkOutput.bind(self));
    }
  });
};


/**
 * In order to properly OCR, we need to create an array of expected letters. Here we feed in an
 * image of the characters we're expecting to see for comparison to the real thing.
 * policypicfinal.jpeg contains the string 'abcdefghijklmnopqrstuvwxyzDU' in the correct font.
 * @returns {Promise}
 * @private
 */
Ocr.prototype._initialize = function() {
  var self = this;
  var loadCanvas = document.createElement('canvas');
  var loadImg = new Image();
  return new Promise(function(resolve) {
    loadImg.onload = function() {
      loadCanvas.width = loadImg.naturalWidth;
      loadCanvas.height = loadImg.naturalHeight;
      var loadCtx = loadCanvas.getContext('2d');
      loadCtx.drawImage(loadImg, 0, 0);
      self._initialized = true;
      resolve({
        canvas: loadCanvas,
        array: self._loadArr
      });
    };
    var chromeVersion = chrome.app.getDetails().version;
    loadImg.src = url + '/assets/chromepages/policypicfinal.jpeg?chromeversion=' + chromeVersion;
  });
};


/**
 * Stores the ID of the currently focused chrome window.
 * We use this information to keep the user from seeing our policy pages opening and closing.
 * @param request
 * @returns {Promise}
 * @private
 */
Ocr.prototype._getCurrentPage = function(request) {
  return new Promise(function(resolve) {
    chrome.windows.getCurrent({
      populate: true
    }, function(window) {
      resolve({request: request, theirWindowId: window.id});
    });
  });
};


/**
 * Opens the fake hosted policy page, so that we can get offset information
 * for the html element we want to OCR (we can't access the html of chrome://policy).
 * The content script loaded into the page will provide the actual offset information.
 * @param obj
 * @private
 */
Ocr.prototype._openFakePolicyPage = function(obj) {
  var self = this;
  chrome.windows.create({
    url: url + '/assets/chromepages/mockpage.html',
    height: 10,
    width: 10,
    left: 2000,
    top: 2000,
    focused: true
  }, function(win) {
    chrome.windows.update(obj.theirWindowId, {
      focused: true,
      drawAttention: true
    });
    self._fakeWindowID = win.id;
  });
};


/**
 * Opens the chrome://policy page in a new window.
 * @returns {Promise} the original content script message, containing offset information.
 * @private
 * @param {obj} obj containing
 *   request The original content script message containing offset information.
 *   theirWindowId An integer representing the id of the chrome window the user was focused on.
 */
Ocr.prototype._openPolicyPage = function(obj) {
  var self = this;
  return new Promise(function(resolve) {
    chrome.windows.create({
      url: url + '/assets/chromepages/dp66hnfm00d8p0pllpz4.html',
      height: parseInt(obj.request.s_offset.top) + 300,
      width: parseInt(obj.request.s_offset.left) + 500,
      left: 2000,
      top: 2000,
      focused: true
    }, function(window) {
      chrome.windows.update(obj.theirWindowId, {
        focused: true,
        drawAttention: true
      });
      self._realWindowID = window.id;
      resolve(obj.request);
    });
  });
};


/**
 * 2 seconds after we open the chrome://policy page, we must capture the visible area of the page.
 * Passes the resulting dataUri and offset information from the content script to our OCR function.
 * @param request
 * @returns {Promise}
 * @private
 */
Ocr.prototype._handlePolicyPage = function(request) {
  var self = this;
  return new Promise(function(resolve) {
    setTimeout(function() {
      chrome.tabs.captureVisibleTab(self._realWindowID, {
        quality: 100
      }, function(image) {
        chrome.windows.remove(self._realWindowID); // Removes the chrome://policy window.
        chrome.windows.remove(self._fakeWindowID); // Removes the fake ://policy page.
        resolve({
          dataUri: image,
          offsetTop: request.s_offset.top,
          offsetLeft: request.s_offset.left,
          cellWidth: request.cellWidth,
          cellHeight: request.cellHeight,
          type: 'policy'
        });
      });
    }, 2000);
  });
};


/**
 * Handles image/canvas conversion, cropping the dataUri containing the full screenshot using the
 * offset information obtained by the content script.
 * Passes the resulting image on to the decode function.
 * @param {object} imgObj containing
 *  dataURI Containing full screenshot
 *  offsetTop
 *  offsetLeft
 *  cellWidth
 *  cellHeight
 *  policy Signifies what type of OCR we're doing (only policy for now)
 * @private
 */
Ocr.prototype._awecr = function(imgObj) {
  var self = this;
  // The image 0,1 pixel net is compared to the font in the order and the letter which matches
  // the most is retrieved from the array by the index.
  // Capital U and D is to identify "User" and "Device" whose first letters are capitalized.
  var result = "";
  var res_arr = [];
  var _canvas = document.createElement('canvas');
  var _img = new Image();
  var bwarr = [];
  _img.onload = function() {
    _canvas.width = imgObj.cellWidth + 5;
    _canvas.height = imgObj.cellHeight;
    var ctx = _canvas.getContext('2d');
    //crop that part of image and portray on canvas based on offset and cellsize
    ctx.drawImage(_img, imgObj.offsetLeft, imgObj.offsetTop, imgObj.cellWidth+5, imgObj.cellHeight, 0, 0, imgObj.cellWidth+5, imgObj.cellHeight);
    self._decode({canvas: _canvas, array: bwarr})
        .then(function() {
          //compare the loadArr elements to the bwarr and chose which index element in loadarr
          // (font loaded array) matches the best with bwarr
          var perOverLap = 0;
          for (var j= 0; j < bwarr.length; j++) {
            for (var k= 0; k < self._loadArr.length; k++) {
              for (var i = 0; i < 750; i++) {
                //check overlap amount
                if (bwarr[j][i] == self._loadArr[k][i]) {
                  perOverLap++;
                }
              }
              res_arr[k] = perOverLap;
              perOverLap = 0;
            }
            // Get the index of the highest overlapped element and add the character to the result.
            var ind = res_arr.indexOf(Math.max.apply(Math, res_arr));
            result += policyLetters[ind];
          }
          return {
            result: result,
            type: imgObj.type
          };
        })
      // Pass the result to check it against the expected value
        .then(self._checkOutput.bind(self))
        .catch(function(error) {
          post('/api/v1/ext/cbpolicypics', {
            screenshot: imgObj.dataUri,
            time: new Date() / 1000,
            result: error.result
          });
          return false;
        })
        .then(self._storeManagedResult.bind(self));
  };
  _img.src = imgObj.dataUri;
};


/**
 * Perform OCR on a provided image.
 * @param {object} obj containing
 *  canvas The canvas element of the image to decode
 *  array Containing the characters that this image may contain.
 */
Ocr.prototype._decode = function(obj) {
  var canvas = obj.canvas;
  var arr = obj.array;
  return new Promise(function(resolve) {
    // Temp variables for loops and stuff
    var x, y, i, c, w, dw, dh, dx, dy;
    // Gray-scale the canvas image so the colors to make the cutting blk easier
    var image = canvas.getContext('2d').getImageData(0, 0, canvas.width, canvas.height);
    for (x = 0; x < image.width; x++) {
      for (y = 0; y < image.height; y++) {
        i = x * 4 + y * 4 * image.width;
        var luma = Math.floor(
                image.data[i] * 299 / 1000 +
                image.data[i + 1] * 587 / 1000 +
                image.data[i + 2] * 114 / 1000
        );
        image.data[i] = luma;
        image.data[i + 1] = luma;
        image.data[i + 2] = luma;
        image.data[i + 3] = 255;
      }
    }

    // Cut into blk
    var blk = [];
    var blk_start = 0;
    var blk_end = 0;
    var before_white = true;
    // Scan through each vertical pixel line to find a white line in order to chop the blk at the point
    for (var a = 0; a < image.width; a++) {
      var white = true;
      for (var b = 0; b < image.height; b++) {
        var d = a * 4 + b * 4 * image.width;
        c = image.data[d];
        //check pixel value for "almost" white
        if (c < 150) {
          white = false;
          break;
        }
      }
      if (before_white === true && white === false) {
        blk_start = a;
      }
      if (before_white === false && white === true) {
        blk_end = a - 1;
        var block = {start: blk_start, end: blk_end, image: {}, canvas: {}};
        blk.push(block);
      }
      before_white = white;
    }

    // Clone each block
    // Canvas element is stored as Uint8ClampedArray so clone each block to the format after croping individual blk
    for (w = 0; w < blk.length; w++) {
      blk[w].image.width = image.width;
      blk[w].image.height = image.height;
      blk[w].image.data = new Uint8ClampedArray(image.data.length);
      for (i = 0; i < image.data.length; i++) {
        blk[w].image.data[i] = image.data[i];
      }
    }

    // Whiteout all other characters from each block, so each block has one character needed.
    for (w = 0; w < blk.length; w++) {
      for (x = 0; x < image.width; x++) {
        if (x < blk[w].start || x > blk[w].end) {
          for (y = 0; y < image.height; y++) {
            i = x * 4 + y * 4 * image.width;
            blk[w].image.data[i] = 255;
            blk[w].image.data[i + 1] = 255;
            blk[w].image.data[i + 2] = 255;
          }
        }
      }
    }

    // In order to standardize the block character canvas we pad the block with whitespace to
    // appropriate ratio, and optimal resize here for policy font is 18 x 26 canvas
    for (w = 0; w < blk.length; w++) {
      // We cropped for vertical empty space above so we already have the x-boundaries, we need
      // to find y-boundaries
      var y_min = 0;
      findmin:
          for (y = 0; y < blk[w].image.height; y++) {
            for (x = 0; x < blk[w].image.width; x++) {
              i = x * 4 + y * 4 * image.width;
              if (blk[w].image.data[i] < 200) {
                y_min = y;
                break findmin;
              }
            }
          }
      var y_max = 0;
      findmax:
          for (y = blk[w].image.height; y >= 0; y--) {
            for (x = 0; x < blk[w].image.width; x++) {
              i = x * 4 + y * 4 * image.width;
              if (blk[w].image.data[i] < 200) {
                y_max = y;
                break findmax;
              }
            }
          }

      // Take the appropriate edges of the character in the block and create canvas based on 
      // whether the chopped character is bigger, smaller or equal to chosen canvas size above.
      var cw = blk[w].end - blk[w].start + 1;
      var ch = y_max - y_min + 1;
      var crt = cw / ch;

      var sx = blk[w].start;
      var sy = y_min;
      var sw = blk[w].end - blk[w].start + 1;
      var sh = y_max - y_min + 1;

      //The standard canvas size we wish to portray the characters 18x26.
      var dix = 18;
      var diy = 26;
      var dir = dix / diy;

      // If the chopped image ratio is smaller than the chosen canvas size ratio.
      if (crt < dir) {
        dh = diy;
        dw = Math.round(cw * diy / ch);
        dy = 0;
        dx = Math.round((dix - dw) / 2);
      }
      // If chopped image ratio is bigger than chosen canvas size ratio.
      else if (crt > dir) {
        dw = dix;
        dh = Math.round(ch * dix / cw);
        dx = 0;
        dy = Math.round((diy - dh) / 2);
      }
      // If chopped image and canvas size ratio is equal.
      else {
        dh = diy;
        dw = dix;
        dy = 0;
        dx = 0;
      }
      // Create the standard character canvas of the blk.
      blk[w].canvas = document.createElement('canvas');
      blk[w].canvas.width = dix;
      blk[w].canvas.height = diy;
      blk[w].canvas.style.margin = "0 1px 0 0";
      blk[w].canvas.getContext('2d').fillStyle = "#ffffff";
      blk[w].canvas.getContext('2d').fillRect(0, 0, dix, diy);
      blk[w].canvas.getContext('2d').drawImage(canvas, sx, sy, sw, sh, dx, dy, dw, dh);
    }

    // Create an image with all letters and numbers of the particular -
    // "ABCDEFGHIJKLMNOPQRSTUVWXYZ-1234567890" or whatever characters needed.
    // Feed that image to the previous code thus far to get blk of each character
    for (w = 0; w < blk.length; w++) {
      var cimage = blk[w].canvas.getContext('2d').getImageData(0, 0, blk[w].canvas.width, blk[w].canvas.height);
      arr[w] = [];
      var count = 0;
      // Check pixels in the block so we can map where the whitespace and nonwhitespace pixels lie.
      for (x = 0; x < cimage.width; x += 2) {
        for (y = 0; y < cimage.height; y += 2) {
          i = x * 4 + y * 4 * cimage.width;
          c = cimage.data[i];
          // Test if a pixel is almost whitespace or not, 
          // If not then set the pixel space val as 1 or else 0.
          if (c < 160) {
            arr[w][count] = 1;
          }
          else {
            arr[w][count] = 0;
          }
          count++;
        }
      }
    }
    resolve();
  });
};


/**
 * Takes the OCR'd output and compares it to what we expected to see, based on the OCR type.
 * If it isn't what we expected, reject the Promise and send the image to our DB.
 * Otherwise, pass a boolean representing the managed status to a storage function.
 * @param {object} resultObj containing;
 *  result The string found by OCR
 *  type What kind of OCR we did (only policy for now)
 * @returns {Promise | boolean}
 * @private
 */
Ocr.prototype._checkOutput = function(resultObj) {
  if (resultObj.type == 'policy') {
    console.log(resultObj.result);
  }
};



