export default function (initialState, states = {}) {
  /*
   * Core Finite State Machine functionality
   * - adheres to Svelte store contract (https://svelte.dev/docs#Store_contract)
   * - invoked events are dispatched to handler of current state
   * - transitions to returned state (or value if static property)
   * - calls _exit() and _enter() methods if they are defined on exited/entered state
   */
  const subscribers = new Set();
  let proxy;
  let state = null;

  function subscribe(callback) {
    if (typeof callback !== 'function') {
      throw new TypeError("Invalid callback");
    }
    subscribers.add(callback);
    callback(state);
    return () => subscribers.delete(callback);
  }

  /*
   * API change: subscribers are notified after _enter, not before, because eventless transitions
   * might mean we settle in a new state. We may well transit through several states during the
   * _enter() call. 
   * 
   * The logic here is intricate. The protocol is that there is always, internally, calls to 
   * _exit() followed by _enter(), with the same to and from arguments. The initial _exit()
   * and the final _enter() will use the public event. All calls will have the original event
   * and args -- since we never know in advance whether an event is a final one. If _enter()
   * returns a new state, we then generate a new _exit() and _enter, moving from the previous
   * state to the new one, and repeat. If it does not, then that _enter is the final call.
   */
  function transition(newState, event, args) {
    let metadata = { from: state, to: newState, event, args };
    let startState = state;

    // Never exit the null state
    if (state !== null) {
      dispatch('_exit', metadata);
    }

    while(true) {
      state = metadata.to;
      const nextState = dispatch('_enter', metadata);
      if (! nextState) {
        break;
      }

      metadata = { from: metadata.to, to: nextState, event, args }
      dispatch('_exit', metadata);
    }

    // If (and only if) the final state is not the same as the initial state, then we 
    // inform the subscribers
    if (state !== startState) {
      subscribers.forEach((callback) => callback(state));
    }
  }

  function dispatch(event, ...args) {
    const action = states[state]?.[event] ?? states['*']?.[event];
    return action instanceof Function ? action.apply(proxy, args) : action;
  }

  function invoke(event, ...args) {
    const newState = dispatch(event, ...args)?.valueOf();
    if (['string', 'symbol'].includes(typeof newState) && newState !== state) {
      transition(newState, event, args);
    }
    return state;
  }

  /*
   * Debounce functionality
   * - `debounce` is lazily bound to dynamic event invoker methods (see Proxy section below)
   * - `event.debounce(wait, ...args)` calls event with args after wait (unless called again first)
   * - cancels all prior invocations made for the same event
   * - cancels entirely when called with `wait` of `null`
   */
  const timeout = {};

  async function debounce(event, wait = 100, ...args) {
    clearTimeout(timeout[event]);
    if (wait === null) {
      return state;
    } else {
      await new Promise((resolve) => timeout[event] = setTimeout(resolve, wait));
      delete timeout[event];
      return invoke(event, ...args);
    }
  }

  /*
   * Proxy-based event invocation API:
   * - return a proxy object with single native subscribe method
   * - all other properties act as dynamic event invocation methods
   * - event invokers also respond to .debounce(wait, ...args) (see above)
   * - subscribe() also behaves as an event invoker when called with any args other than a
   *   single callback (or when debounced)
   */
  proxy = new Proxy({ subscribe }, {
    get(target, property) {
      if (!Reflect.has(target, property)) {
        target[property] = invoke.bind(null, property);
        target[property].debounce = debounce.bind(null, property);
      }
      return Reflect.get(target, property);
    }
  });

  /*
   * `_enter` initial state and return the proxy object. Note that this may also
   * involve eventless transitions to other states. Note, interestingly, that 
   * we are free to notify here, because there will never be subscribers.
   */
  transition(initialState, null, []);
  return proxy;
}
