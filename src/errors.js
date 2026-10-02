// An error we expect (bad input, seat taken, ...). Carries the HTTP status to send.
class HttpError extends Error {
  constructor(status, code, message, extra = {}) {
    super(message);
    this.status = status;
    this.code = code;
    this.extra = extra;
  }
}

module.exports = { HttpError };
